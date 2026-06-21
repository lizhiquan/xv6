# Chapter 21 — Testing It All

> A kernel can pass every quick demo and still harbor races and leaks that only
> surface under sustained load. This chapter builds the stress tests that hunt
> them: forking until the process table is exhausted, hammering the file system
> from many processes, filling the log past its capacity, and running for ages to
> catch the one-in-a-million interleaving. Passing these is what separates "it
> booted" from "it works."
>
> Milestone: the test suite passes.

---

## 21.1 Why stress tests, not just unit tests

The bugs that matter in a kernel are rarely simple logic errors — those show up
the first time you run the code. The dangerous ones are **emergent**: a race that
needs two CPUs to hit a 3-instruction window, a leak that only matters after
thousands of allocations, a recovery bug that needs a crash at one exact moment.
You find these by doing the operation *a lot*, *concurrently*, and *checking
invariants* afterward.

So our tests are programs (run from the shell, Chapter 19) that pound a subsystem
and then verify nothing broke. They're user programs like any other — which is
itself a good sign: if the test harness runs, the basics already work.

---

## 21.2 `forktest`: exhausting the process table

The simplest stress test creates processes until it can't, then reaps them all,
checking the count comes out even:

```go
// forktest.go
func main() {
	const N = 1000
	n := 0
	for ; n < N; n++ {
		pid := fork()
		if pid < 0 {
			break // process table full — expected
		}
		if pid == 0 {
			exit(0) // child exits immediately
		}
	}
	if n == N {
		printf(1, "fork claimed to work %d times!\n", N)
		exit(1)
	}
	for ; n > 0; n-- {
		if wait(nil) < 0 {
			printf(1, "wait stopped early\n")
			exit(1)
		}
	}
	if wait(nil) != -1 {
		printf(1, "wait got too many\n")
		exit(1)
	}
	printf(1, "fork test OK\n")
}
```

This exercises `allocproc`/`fork`/`exit`/`wait` (Chapter 11) at the table's
limits. It catches off-by-one errors in the process table, leaks of process slots,
and zombies that never get reaped. The final `wait` returning `-1` proves there
are no stragglers.

---

## 21.3 `stressfs`: hammering the file system

`stressfs` forks several children, each writing and reading a distinct file
repeatedly, to surface races in the buffer cache, log, and inode layers:

```go
// stressfs.go
func main() {
	const nProc = 4
	data := make([]byte, 512)
	var path = []byte("stressfs0")

	id := 0
	for ; id < nProc; id++ {
		if fork() == 0 {
			break // each child gets a different id
		}
	}
	path[8] = byte('0' + id)

	fd := open(string(path), O_CREATE|O_RDWR)
	for i := 0; i < 20; i++ {
		write(fd, ptrTo(&data), len(data)) // many writes -> many transactions
	}
	close(fd)

	fd = open(string(path), O_RDONLY)
	for i := 0; i < 20; i++ {
		read(fd, ptrTo(&data), len(data))
	}
	close(fd)

	if id == 0 {
		for i := 0; i < nProc; i++ {
			wait(nil)
		}
	}
	exit(0)
}
```

Four processes writing concurrently force the buffer cache's single-copy
guarantee (Chapter 13), the log's group commit (Chapter 14), and inode locking
(Chapter 15) to all hold at once. A bug in any of them shows up as wrong data, a
panic, or a hang.

---

## 21.4 `logstress`: overflowing the log

The logging layer (Chapter 14) blocks operations when the log would overflow.
`logstress` deliberately runs operations that fill the log to its limit, checking
that `beginOp`'s back-pressure works and that nothing corrupts when the log is
nearly full:

```go
// logstress.go (idea)
func main() {
	// Create files and write enough blocks per transaction to approach
	// LOGBLOCKS, repeatedly, from multiple processes. Then verify every
	// file has exactly the bytes we wrote — proving no transaction was
	// torn or lost when the log filled.
	// …
}
```

This targets the trickiest invariant in the file system: that a transaction never
exceeds the log, and that concurrent transactions correctly serialize when space
is tight. It's exactly the kind of thing that "works" in casual use and explodes
under a real workload.

---

## 21.5 `usertests`: the grand suite

`usertests` is the comprehensive suite — dozens of focused tests plus a few
marathon ones. It checks corner cases methodically:

- **Memory**: `sbrk` growth and shrinkage, allocation up to the limit,
  out-of-memory handling, that freed memory is reusable.
- **File system**: large files (exercising indirect blocks, Chapter 15), many
  small files, deep directories, unlinking open files, `link`/`unlink` races.
- **Boundaries**: passing bad pointers and out-of-range addresses to syscalls,
  confirming the kernel returns errors instead of crashing (the `copyin`/`copyout`
  checks from Chapter 6).
- **Processes**: `fork`/`wait`/`exit` under pressure, `kill` of sleeping and
  running processes, reparenting.

```go
// usertests.go (shape)
var tests = []struct {
	f    func()
	name string
}{
	{sbrkbasic, "sbrkbasic"},
	{bigfile, "bigfile"},
	{badwrite, "badwrite"},     // hand a bad pointer to write(): must return -1
	{reparent, "reparent"},
	{forkforkfork, "forkforkfork"},
	// … dozens more …
}

func main() {
	for _, t := range tests {
		printf(1, "test %s: ", t.name)
		if fork() == 0 {
			t.f()       // run in a child so a crash doesn't kill the suite
			exit(0)
		}
		wait(nil)
		printf(1, "OK\n")
	}
	printf(1, "ALL TESTS PASSED\n")
}
```

Running each test in a forked child is itself a design choice: a test that
*should* fault (handing the kernel a bad pointer) does so in a child, and the
parent observes the result without dying. The boundary tests are especially
valuable — they verify the security gate from Chapter 6 actually rejects hostile
input.

---

## 21.6 `grind`: the long random run

`grind` does random operations — fork, file ops, pipes, growth — in a loop, for a
long time, with different timing each run. It's looking for the rare interleaving
that the deterministic tests miss. There's no clever assertion; the test is simply
*does the kernel survive thousands of random operations across several CPUs
without panicking, hanging, or corrupting data*. Run long enough, `grind` is the
truest measure that the locking (Chapter 9) and scheduling (Chapter 10) are
actually correct.

---

## 21.7 What you should take away

- Kernel bugs are mostly **emergent** — races, leaks, recovery edge cases — so we
  test by doing operations **a lot, concurrently, then checking invariants**.
- **`forktest`** stresses the process table to its limit; **`stressfs`** hammers
  the file system from many processes; **`logstress`** fills the log to test
  back-pressure.
- **`usertests`** is the methodical suite — memory, file system, and crucially the
  **bad-pointer boundary tests** that prove `copyin`/`copyout` reject hostile
  input; each test runs in a forked child.
- **`grind`** runs random operations for ages to flush out the rare interleaving —
  the real test of locking and scheduling.

---

## Exercises

1. **Why a child per test?** Explain why `usertests` runs each test in a forked
   child. What would happen to the suite if a test that's *supposed* to fault ran
   in the main process?

2. **The even count.** `forktest` ends by checking `wait(nil) == -1`. What bug
   would a non-`-1` result reveal? What about a `wait` that blocks forever there?

3. **Boundary test.** Write a test that hands `write` a pointer just past the end
   of the process's address space. What must the kernel return, and which chapter's
   code makes that happen?

4. **Reproducing a race.** A race needs a 2-instruction window on two CPUs. Why is
   `grind` more likely to hit it than `stressfs`? What role does running on
   multiple harts (Chapter 9) play?

5. **Log overflow.** Design a `logstress` workload that would expose a bug where
   `beginOp` *underestimates* how many blocks a transaction needs. What symptom
   would the bug produce?

---

*Next: **Chapter 22 — Reflections on Go in a Kernel**, where we step back and
assess what building an OS in Go cost us and gave us — the GC, `unsafe`, binary
size, and where the abstractions leaked.*
