# Chapter 19 — The Shell

> The shell is where everything we built meets the user. It's an ordinary user
> program — no special privileges — yet it orchestrates the entire process and
> file machinery: it reads a command line, parses it, and wires up `fork`, `exec`,
> `open`, `pipe`, and `dup` to run programs with redirection and pipelines. Seeing
> the shell work is seeing the whole kernel work.
>
> Milestone: an interactive shell.

---

## 19.1 The shell is just a program

A crucial point: the shell has no kernel powers. It runs in user mode like any
program and reaches the kernel only through the syscalls from Chapter 18. Its
power comes entirely from *composing* those syscalls. If you understand how the
shell runs `ls | wc > out`, you understand how Unix runs everything.

Its main loop is tiny:

```go
// sh.go
func main() {
	var buf [128]byte
	for getcmd(&buf) >= 0 {
		// special-case "cd": it must change the SHELL's own directory,
		// so it can't run in a forked child.
		if isCd(buf) {
			chdir(cdArg(buf))
			continue
		}
		if fork1() == 0 {
			runcmd(parsecmd(buf)) // child: run the command, never returns
		}
		wait(nil) // parent: wait for it to finish
	}
	exit(0)
}
```

`fork`, run the command in the child via `exec`, `wait` in the parent — the
lifecycle from Chapter 11. `cd` is the famous exception: it must change the
*shell's* current directory, so it can't run in a child that would just exit. Every
other command runs in a fresh child.

---

## 19.2 Parsing into a command tree

A command line has structure — pipes connect commands, `>` redirects them, `;`
sequences them — so the shell parses it into a small **tree** of command nodes.
Each node type captures one construct:

```go
// sh.go
type cmdKind int
const (
	execCmd  cmdKind = iota // a program + arguments
	redirCmd                // a command with input/output redirected
	pipeCmd                 // left | right
	listCmd                 // left ; right
	backCmd                 // command &
)

type cmd struct {
	kind cmdKind
	// execCmd:  argv []string
	// redirCmd: sub *cmd; file string; mode int; fd int
	// pipeCmd:  left, right *cmd
	// …
}
```

Parsing `ls -l | wc > out` yields:

```
        pipeCmd
        /      \
   execCmd     redirCmd (> out, fd 1)
   "ls -l"        |
              execCmd "wc"
```

The parser is a small recursive-descent affair (`parsecmd` → `parsepipe` →
`parseexec`), reading the structure into this tree. The interesting part isn't the
parsing — it's what `runcmd` does with the tree.

---

## 19.3 `runcmd`: turning the tree into syscalls

`runcmd` walks the tree, and each node kind maps to a specific syscall pattern.
This function *is* the payoff of the whole book — every kernel mechanism appears:

```go
// sh.go
func runcmd(c *cmd) {
	switch c.kind {
	case execCmd:
		exec(c.argv[0], c.argv) // replace this child with the program (Chapter 8)
		printf(2, "exec %s failed\n", c.argv[0])

	case redirCmd:
		close(c.fd)             // close fd 1 (or 0)
		open(c.file, c.mode)    // reopen it on the file — lands in fd 1 (Chapter 17)
		runcmd(c.sub)           // now run the command; its output goes to the file

	case pipeCmd:
		var p [2]int
		pipe(&p)                // p[0] = read end, p[1] = write end (Chapter 17)
		if fork1() == 0 {
			close(1)            // left child: stdout -> pipe write end
			dup(p[1])
			close(p[0]); close(p[1])
			runcmd(c.left)
		}
		if fork1() == 0 {
			close(0)            // right child: stdin -> pipe read end
			dup(p[0])
			close(p[0]); close(p[1])
			runcmd(c.right)
		}
		close(p[0]); close(p[1])
		wait(nil); wait(nil)    // wait for both halves

	case listCmd:
		if fork1() == 0 {
			runcmd(c.left)
		}
		wait(nil)
		runcmd(c.right)

	case backCmd:
		if fork1() == 0 {
			runcmd(c.sub)       // background: don't wait
		}
	}
	exit(0)
}
```

Look at how little code each construct needs, and how it leans entirely on
Chapter 17's lowest-free-descriptor rule:

- **Redirection** (`> out`): `close(1)` then `open("out")`. Because `open` returns
  the lowest free descriptor, and we just freed 1, the file *becomes* fd 1. The
  program then writes to fd 1 as always, oblivious that it's a file.
- **Pipe** (`left | right`): create a pipe, fork two children; the left's fd 1 is
  `dup`'d onto the pipe's write end, the right's fd 0 onto the read end. `ls`
  writes to "stdout," `wc` reads from "stdin," and the kernel pipe (Chapter 17)
  carries bytes between them.

No program — `ls`, `wc` — knows anything about redirection or pipes. The shell
rearranges their descriptors *before* `exec`, and they just use fd 0, 1, 2. That
is the deep elegance of the Unix file-descriptor design.

---

## 19.4 Why redirection setup happens before `exec`

The ordering is the whole trick. The shell forks a child, and *in the child,
before `exec`*, it rearranges descriptors. Then `exec` replaces the program but
**keeps the descriptor table** (Chapter 8: `exec` preserves open files). So the
new program inherits exactly the fds the shell set up. A child running `wc` with
fd 0 pointing at a pipe never had to cooperate — its environment was arranged for
it.

```
fork ──► child: close(1); open("out")  ──► exec("ls")  ──► ls writes fd 1 → out
         (rearrange fds)                    (fds survive)
```

This separation — *set up the environment in the child, then exec* — is why the
shell can compose arbitrary programs it didn't write and knows nothing about.

---

## 19.5 What you should take away

- The shell is an **ordinary user program**; its power is entirely in *composing*
  syscalls.
- It parses a command line into a small **command tree** (exec/redir/pipe/list/
  back); `runcmd` walks it.
- **Redirection** is `close` + `open` exploiting the lowest-free-descriptor rule;
  **pipes** are `pipe` + `fork` + `dup` connecting two children.
- Descriptors are rearranged **in the child before `exec`**, and `exec` preserves
  them, so unmodified programs inherit a custom I/O environment.
- `cd` is special because it must change the **shell's own** directory, so it
  can't run in a child.

---

## Exercises

1. **Trace a pipeline.** Step through `runcmd` for `cat f | grep x`. List every
   `fork`, `pipe`, `dup`, `close`, and `exec`, and which fd points where in each
   child at the moment of `exec`.

2. **Why before exec?** Explain what would break if the shell tried to set up
   redirection *after* `exec` instead of before. Could it even?

3. **cd in a child.** Suppose `cd` were not special-cased and ran via
   `fork`+`exec` like other commands. Demonstrate why typing `cd /tmp` would then
   appear to do nothing.

4. **Descriptor leak.** In the `pipeCmd` case, why must both the parent *and* each
   child `close` both pipe ends they don't use? What hangs if the parent forgets to
   close the write end?

5. **Build a feature.** Sketch the parser and `runcmd` changes to support `>>`
   (append redirection). Which syscall flag from Chapter 17 do you need, and where
   does it go in the tree?

---

*Next: **Chapter 20 — The Userland Utilities**, where we build the familiar
programs — `cat`, `echo`, `ls`, `grep`, `wc`, and friends — that turn a kernel
with a shell into a usable system.*
