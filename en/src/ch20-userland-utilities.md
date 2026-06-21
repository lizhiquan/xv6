# Chapter 20 — The Userland Utilities

> A kernel with a shell can run programs — but it needs programs to run. This
> chapter builds the familiar Unix utilities: `cat`, `echo`, `ls`, `grep`, `wc`,
> `mkdir`, `rm`, `ln`, `kill`, and the all-important `init`. Each is small,
> single-purpose, and built entirely from the user library (Chapter 18) and the
> syscalls. Together they turn the kernel into a usable single-user system.
>
> Milestone: a usable single-user system.

---

## 20.1 The Unix philosophy in practice

Each utility does one thing and reads/writes through file descriptors, so the
shell can redirect and pipe them (Chapter 19). None of them knows whether its
input is the keyboard, a file, or a pipe — they just use fds 0, 1, 2. This is the
payoff of every abstraction we built: a 30-line program composes with every other
program for free.

The pattern of almost every utility is "loop over input, do something, write
output." The simplest possible example is `echo`:

```go
// echo.go
func main(argc int, argv []string) {
	for i := 1; i < argc; i++ {
		write(1, strPtr(argv[i]), len(argv[i]))
		if i+1 < argc {
			write(1, strPtr(" "), 1)
		} else {
			write(1, strPtr("\n"), 1)
		}
	}
	exit(0)
}
```

That's a complete program. Everything else is variations on reading input and
producing output.

---

## 20.2 `cat`: the read/write loop

`cat` copies its input (files named as arguments, or stdin if none) to stdout. It
is the canonical "fd-agnostic" program:

```go
// cat.go
func cat(fd int) {
	var buf [512]byte
	for {
		n := read(fd, ptrTo(&buf), len(buf))
		if n <= 0 {
			break
		}
		if write(1, ptrTo(&buf), n) != n {
			printf(2, "cat: write error\n")
			exit(1)
		}
	}
}

func main(argc int, argv []string) {
	if argc <= 1 {
		cat(0) // no args: copy stdin
		exit(0)
	}
	for i := 1; i < argc; i++ {
		fd := open(argv[i], O_RDONLY)
		if fd < 0 {
			printf(2, "cat: cannot open %s\n", argv[i])
			exit(1)
		}
		cat(fd)
		close(fd)
	}
	exit(0)
}
```

Because `cat` reads from a numbered fd, `cat < file`, `cat file`, and `echo hi |
cat` all work without `cat` doing anything special — the shell arranged fd 0 for
it (Chapter 19).

---

## 20.3 `ls`, `grep`, `wc`: reading structure

These add a little logic on top of the read loop:

- **`ls`** opens a directory and reads its raw `dirent` entries (Chapter 16), then
  `fstat`s each to print type and size. It's a user program reading the
  directory's bytes — the same bytes `dirlookup` reads in the kernel, exposed
  through `read`.
- **`grep`** reads lines and writes those matching a pattern. It contains a tiny
  regex matcher (`^`, `$`, `.`, `*`) — a self-contained algorithm, no kernel
  involvement beyond read/write.
- **`wc`** reads bytes and counts lines, words, and characters — pure
  accumulation over the read loop.

```go
// wc.go (core)
func wc(fd int, name string) {
	var buf [512]byte
	l, w, c := 0, 0, 0
	inword := false
	for {
		n := read(fd, ptrTo(&buf), len(buf))
		if n <= 0 {
			break
		}
		for i := 0; i < n; i++ {
			c++
			if buf[i] == '\n' {
				l++
			}
			if isSpace(buf[i]) {
				inword = false
			} else if !inword {
				inword = true
				w++
			}
		}
	}
	printf(1, "%d %d %d %s\n", l, w, c, name)
}
```

Notice `ls` is the one that reaches into file-system structure (reading `dirent`s
directly), which is only possible because Chapter 16 made a directory a readable
file. `grep` and `wc` don't care about files at all — they're byte processors.

---

## 20.4 `mkdir`, `rm`, `ln`, `kill`: thin syscall wrappers

Some utilities are barely more than a single syscall plus argument handling:

```go
// mkdir.go
func main(argc int, argv []string) {
	for i := 1; i < argc; i++ {
		if mkdir(argv[i]) < 0 {
			printf(2, "mkdir: %s failed to create\n", argv[i])
			break
		}
	}
	exit(0)
}
```

- **`rm`** calls `unlink` (Chapter 16) for each argument.
- **`ln`** calls `link` — creating a second name for a file.
- **`kill`** calls `kill(pid)` (Chapter 11) — cooperative termination.

These exist because the *command line* is the user interface to syscalls; the
utility just parses arguments and makes the call. There's almost nothing to them,
which is exactly the point — the work is in the kernel; the utility is a thin
shell over it.

---

## 20.5 `init`: the first real program

`init` is special: it's the program `exec`'d by the hand-crafted first process
(Chapter 8), and it's the ancestor of everything. Its job is to set up the console
and start a shell, restarting it whenever it exits:

```go
// init.go
func main() {
	// Open the console as fd 0, 1, 2 if not already (first boot).
	if open("console", O_RDWR) < 0 {
		mknod("console", CONSOLE, 0) // create the console device file
		open("console", O_RDWR)      // fd 0
	}
	dup(0) // fd 1 (stdout)
	dup(0) // fd 2 (stderr)

	for {
		printf(1, "init: starting sh\n")
		pid := fork()
		if pid == 0 {
			exec("sh", []string{"sh"}) // become the shell
			printf(2, "init: exec sh failed\n")
			exit(1)
		}
		// reap children; if it was our shell, loop and start another
		for {
			wpid := wait(nil)
			if wpid == pid {
				break // our shell died; restart it
			} else if wpid < 0 {
				break
			}
			// otherwise it was a reparented orphan (Chapter 11); keep reaping
		}
	}
}
```

`init` is where the console becomes fds 0/1/2 (via `mknod` to create the device
file, then `open` + two `dup`s), so every program the shell forks inherits a
working console. It also reaps orphaned processes forever (the reparenting target
from Chapter 11). When you boot the system and see a shell prompt, this loop is
what produced it.

---

## 20.6 The system, alive

With these utilities, boot now runs all the way to an interactive session:

```console
xv6-go kernel booting on hart 0
init: starting sh
$ echo hello | wc
      1       1       6
$ mkdir d ; ls
.              1 1 1024
..             1 1 1024
d              1 18 32
console        3 19 0
$
```

Every line of that session exercises the whole stack: the shell forked and
exec'd, the pipe carried bytes, `wc` counted them, the file system created `d`,
`ls` read directory entries — all on a kernel written from scratch in Go. The
machine is a real, if small, Unix.

---

## 20.7 What you should take away

- Utilities are **small, single-purpose, fd-agnostic** programs; the shell's
  redirection/pipes make them compose without their cooperation.
- Most are a **read/write loop** (`cat`, `wc`, `grep`) or a **thin syscall
  wrapper** (`mkdir`, `rm`, `ln`, `kill`).
- **`ls`** reads a directory's raw entries — possible only because a directory is
  a readable file (Chapter 16).
- **`init`** is the ancestor process: it sets up the console as fds 0/1/2, starts
  and restarts the shell, and reaps orphans forever.
- Together they make the kernel a **usable single-user Unix**.

---

## Exercises

1. **fd-agnostic.** Explain why `cat` needs no code to handle the difference
   between `cat file`, `cat < file`, and `echo hi | cat`. Where is that difference
   actually handled?

2. **ls internals.** `ls` reads `dirent` structures directly from a directory via
   `read`. Why is this safe and possible in user space? What kernel decision from
   Chapter 16 enables it?

3. **init's dups.** Trace the `open`/`dup`/`dup` sequence in `init` and show that
   it produces console on fds 0, 1, and 2. Why does every later program inherit
   them?

4. **Restart loop.** Why does `init` `wait` in an inner loop rather than once? What
   processes besides its own shell might `wait` return, and where did they come
   from?

5. **Add a utility.** Write the full source for a `head` utility (print the first
   N lines of stdin or a file). Which existing utility is it closest to, and what
   do you add?

---

*Next: **Chapter 21 — Testing It All**, where we stress every subsystem at once —
concurrency, the file system, crash recovery — to find the bugs that only appear
under load.*
