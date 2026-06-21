# Chapter 3 — Talking to Hardware: the Console

> In Chapter 2 we pushed bytes out the UART with a two-line hack. Now we turn
> that into a real driver: initialize the 16550 properly, build a `printk` that
> formats numbers and strings without the standard library and without
> allocating, and design (but not yet wire up) the interrupt-driven input path
> and the console line discipline. `printk` becomes the kernel's voice for the
> rest of the book — every later chapter uses it to show its work.
>
> Milestone: a polling console you can `printk` to, with `%d`, `%x`, `%s`, `%p`,
> and friends.

---

## 3.1 The 16550 UART, properly

The `virt` machine gives us a 16550-compatible UART at `0x10000000`. It exposes a
handful of one-byte registers; the same offset often means different things on
read vs. write. The ones we care about:

| Offset | Read | Write |
|--------|------|-------|
| 0 | RHR — received byte | THR — byte to transmit |
| 1 | — | IER — interrupt enable |
| 2 | ISR — interrupt status | FCR — FIFO control |
| 3 | — | LCR — line control |
| 5 | LSR — line status | — |

We model the register block as a typed view, exactly as in Chapter 2, and add
read/write helpers:

```go
// uart.go
package kernel

import "unsafe"

const uart0 = 0x10000000

const (
	rhr = 0 // receive holding register (read)
	thr = 0 // transmit holding register (write)
	ier = 1 // interrupt enable register
	fcr = 2 // FIFO control register
	isr = 2 // interrupt status register
	lcr = 3 // line control register
	lsr = 5 // line status register
)

const (
	ierRxEnable  = 1 << 0
	ierTxEnable  = 1 << 1
	fcrFifoEnable = 1 << 0
	fcrFifoClear  = 3 << 1
	lcrEightBits  = 3 << 0
	lcrBaudLatch  = 1 << 7
	lsrRxReady    = 1 << 0 // a byte is waiting in RHR
	lsrTxIdle     = 1 << 5 // THR is empty, ok to send
)

func rdReg(r uintptr) uint8  { return *(*uint8)(unsafe.Pointer(uintptr(uart0) + r)) }
func wrReg(r uintptr, v uint8) { *(*uint8)(unsafe.Pointer(uintptr(uart0) + r)) = v }
```

Initialization sets the baud rate, the word format (8 bits, no parity), turns on
the FIFOs, and enables the receive and transmit interrupts. The interrupts won't
*fire* until we set up traps in Chapter 7 — but configuring them now keeps the
driver in one place:

```go
// uart.go
func uartInit() {
	wrReg(ier, 0x00)                 // disable interrupts during setup

	wrReg(lcr, lcrBaudLatch)         // enter baud-rate-set mode
	wrReg(0, 0x03)                   // divisor LSB: 38.4K baud
	wrReg(1, 0x00)                   // divisor MSB

	wrReg(lcr, lcrEightBits)         // leave baud mode; 8 bits, no parity
	wrReg(fcr, fcrFifoEnable|fcrFifoClear) // enable and clear the FIFOs
	wrReg(ier, ierTxEnable|ierRxEnable)    // enable rx/tx interrupts
}
```

## 3.2 Output, two ways

There are two distinct reasons to send a byte, and they want different
mechanisms:

- **`printk` and echoing** must work *anywhere* — including inside a trap handler,
  before the scheduler exists, or while the kernel is panicking. These can't
  block or sleep, so they **spin** on the LSR. This is the synchronous path.
- **`write()` to the console** by a user process can afford to block; it hands
  bytes to an interrupt-driven queue and sleeps until the UART drains. That path
  needs sleep/wakeup (Chapter 10) and a real lock (Chapter 9), so we only
  *design* it here and finish it later.

The synchronous putc is all we need to be useful today:

```go
// uart.go — synchronous output for printk and echo; never blocks
func uartPutcSync(c byte) {
	for rdReg(lsr)&lsrTxIdle == 0 { // spin until THR is empty
	}
	wrReg(thr, c)
}
```

> **Why two paths at all?** A `printk` from inside an interrupt handler must not
> sleep — there may be no process to sleep, and we might be reporting a crash.
> Spinning is wasteful but always safe. Bulk console writes from user space are
> the opposite: frequent and worth sleeping through. Keeping them separate is a
> theme you'll see again (sync vs. async, Chapters 10 and 17).

---

## 3.3 `printk`: formatting without a standard library

A kernel can't import `fmt` — it allocates, it calls into the runtime, it assumes
an OS. We write a tiny formatter that supports just what the kernel needs:
`%d`, `%x`, `%p`, `%s`, `%c`, and `%%`. It never allocates; it emits one byte at
a time through `uartPutcSync`.

```go
// printk.go
package kernel

const digits = "0123456789abcdef"

// printInt prints v in the given base (10 or 16), optionally signed.
func printInt(v int, base int, signed bool) {
	var buf [20]byte
	neg := false
	x := uint(v)
	if signed && v < 0 {
		neg = true
		x = uint(-v)
	}
	i := 0
	for {
		buf[i] = digits[x%uint(base)]
		i++
		x /= uint(base)
		if x == 0 {
			break
		}
	}
	if neg {
		buf[i] = '-'
		i++
	}
	for i > 0 { // digits were generated least-significant first
		i--
		uartPutcSync(buf[i])
	}
}

func printPtr(p uintptr) {
	uartPutcSync('0')
	uartPutcSync('x')
	for i := 0; i < 16; i++ { // 64 bits = 16 hex digits, high nibble first
		shift := uint(60 - i*4)
		uartPutcSync(digits[(uint64(p)>>shift)&0xf])
	}
}
```

The dispatcher walks the format string. Because Go has no `va_list`, we take a
variadic `...any`; reading a typed value out of `any` is a type switch, which the
compiler turns into a tag check — no allocation:

```go
// printk.go
func printk(format string, a ...any) {
	argi := 0
	next := func() any {
		if argi < len(a) {
			v := a[argi]
			argi++
			return v
		}
		return nil
	}

	for i := 0; i < len(format); i++ {
		if format[i] != '%' {
			uartPutcSync(format[i])
			continue
		}
		i++
		if i >= len(format) {
			break
		}
		switch format[i] {
		case 'd':
			printInt(next().(int), 10, true)
		case 'x':
			printInt(next().(int), 16, false)
		case 'p':
			printPtr(next().(uintptr))
		case 'c':
			uartPutcSync(byte(next().(int)))
		case 's':
			for _, b := range []byte(next().(string)) {
				uartPutcSync(b)
			}
		case '%':
			uartPutcSync('%')
		default:
			uartPutcSync('%')
			uartPutcSync(format[i])
		}
	}
}
```

That's the whole formatter — under a hundred lines, no heap, no imports. It is
deliberately minimal; you'll extend it in the exercises.

---

## 3.4 A lock, previewed

Two CPUs calling `printk` at once would interleave their bytes — `helloworld`
becomes `hweolrllod`. The fix is a lock around the body of `printk`. We don't
build real locks until Chapter 9, so here we just name the seam:

```go
// printk.go
var printLock spinlock // a stub for now; the real one arrives in Chapter 9

func printk(format string, a ...any) {
	acquire(&printLock)
	defer release(&printLock)
	// … formatting as above …
}
```

Until Chapter 2's "only hart 0 prints" rule is lifted (Chapter 9), this lock does
nothing observable — but writing it now documents the requirement and means we
won't forget it when multiple CPUs start printing. **Every shared data structure
in the kernel needs a story for concurrent access; the console is the first.**

A second subtlety, also deferred: a `printk` that panics must not deadlock trying
to re-acquire `printLock`. xv6 handles this with a `panicking` flag that bypasses
locking and interrupt bookkeeping. We'll add it alongside real locks.

---

## 3.5 The input path (designed now, wired in Chapter 7)

Output is solved. Input is harder, because a keystroke arrives *asynchronously* —
the UART raises an interrupt when a byte is ready. We can't handle interrupts
until Chapter 7, so here we lay out the design; the code lands there.

When a receive interrupt fires, the handler reads the byte and feeds it to the
console layer. The console keeps a small ring buffer and a **line discipline**:
it echoes characters, handles editing, and only releases a *whole line* to a
waiting reader. The classic control characters:

| Key | Meaning |
|-----|---------|
| `\n` | end of line — wake the reader |
| Ctrl-H / Backspace | erase the previous character |
| Ctrl-U | kill the whole line |
| Ctrl-D | end of file |
| Ctrl-P | dump the process list (a debugging aid) |

The ring buffer uses three indices into a fixed array — read (`r`), write (`w`),
and edit (`e`):

```go
// console.go (sketch — completed in Chapter 7)
const inputBufSize = 128

type console struct {
	lock spinlock
	buf  [inputBufSize]byte
	r    uint // next index consoleRead will read
	w    uint // end of the line ready to be read
	e    uint // where the next typed character goes (edit point)
}
```

- Typed characters accumulate between `w` and `e`, and are echoed as they arrive.
- Backspace just decrements `e` (and echoes the erase sequence).
- On `\n`, we set `w = e`, making the line available, and wake any reader blocked
  in `consoleRead`.

`consoleRead` (a process asking for input) sleeps while `r == w` — nothing to
read — and copies bytes out once a line is ready. That sleep/wakeup handshake is
the same condition-variable pattern we build in Chapter 10, and `consoleRead`
becomes the `read` implementation for the console *device file* in Chapter 17.

We're describing it now so that when interrupts exist, input is a small, already-
understood addition rather than a new subsystem.

---

## 3.6 Wiring it into boot

`main` from Chapter 2 gains real initialization, and a more confident greeting:

```go
// main.go
func main() {
	if cpuid() == 0 {
		uartInit()
		printk("\n")
		printk("xv6-go kernel booting on hart %d\n", cpuid())
		printk("UART at %p, %d bits, no parity\n", uintptr(uart0), 8)
		printk("\n")
	}
	for {
	}
}
```

```console
$ make qemu

xv6-go kernel booting on hart 0
UART at 0x0000000010000000, 8 bits, no parity

```

If your numbers, hex pointer, and string all render correctly, `printk` works —
and from here on, every chapter can narrate itself.

---

## 3.7 What you should take away

- A device driver is a **register map plus a protocol**: read/write fixed offsets
  in the right order. The 16550 needs baud, format, FIFO, and interrupt-enable
  setup, then it's just RHR/THR/LSR.
- Output needs **two paths**: a spin-on-LSR synchronous path for `printk`/echo
  that is safe anywhere, and a sleeping, interrupt-driven path for bulk writes
  (finished later).
- `printk` is a **self-contained formatter** — no `fmt`, no heap, one byte at a
  time — because the kernel has no standard library beneath it.
- Shared hardware needs a concurrency story; we **named the console lock now**
  even though it isn't enforced until Chapter 9.
- Asynchronous **input** needs interrupts (Chapter 7); we designed the ring buffer
  and line discipline so it'll drop in cleanly.

---

## Exercises

1. **Width and padding.** Extend `printk` to support `%5d` (right-justify in a
   field of width 5). What state do you need to carry between the `%` and the `d`?

2. **Unsigned and longs.** Add `%u` (unsigned decimal) and a 64-bit `%l` (or
   `%ld`). Why does the current `printInt` taking an `int` quietly mishandle very
   large unsigned values?

3. **Why spin, not sleep, in `printk`?** Give two concrete situations where a
   `printk` cannot afford to call `sleep`. (Hint: §3.2 and the panic case in
   §3.4.)

4. **Echo policy.** When the input path is wired up, should a password prompt
   echo what you type? Where in §3.5's design would you add the option to suppress
   echo, and which OS job from Chapter 1 does that serve?

5. **Interleaving.** With the `printLock` stub doing nothing, write a thought
   experiment: two harts each printing `"abc\n"` a thousand times. What kinds of
   garbled output are possible, and which become impossible once the lock is
   real?

---

*Next: **Chapter 4 — Physical Memory Allocation**, where we take control of RAM
itself: a free-list allocator handing out 4096-byte pages, built on memory the Go
garbage collector must never touch.*
