# Chapter 12 — The Disk Driver

> Part IV builds a file system, bottom to top. The bottom is this chapter: a
> driver for the virtio block device, the emulated disk QEMU gives us. We learn
> the virtqueue protocol — how the kernel and device pass requests through shared
> memory — and confront a real Go-in-a-kernel problem: the device reads and writes
> our memory by DMA, so those buffers must never move or be touched by the garbage
> collector.
>
> Milestone: read and write raw disk blocks.

---

## 12.1 What a block device is

A disk, to the kernel, is an array of fixed-size **blocks** (here, 1024 bytes =
two sectors) addressed by number. The driver's entire job is two operations:
*read block N into a buffer* and *write a buffer to block N*. Everything above —
caching, logging, inodes, files — is built on just those two. The disk is slow
(relative to RAM), so the driver must let the calling process **sleep** while the
hardware works, and wake it on completion. That's why we needed Chapters 9 and 10
first.

On the `virt` machine the disk is a **virtio** device, mapped at `0x10001000`
(Chapter 5 mapped its registers). Virtio is a standard for efficient
paravirtualized devices: instead of poking one register per byte, the kernel and
device share a ring of descriptors in memory.

---

## 12.2 The virtqueue

Communication happens through a **virtqueue**: three shared arrays the kernel and
device both read and write.

```
        kernel fills ─►            ◄─ device drains
   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
   │  desc[NUM]   │   │  avail ring   │   │  used ring   │
   │ descriptors: │   │ "here are     │   │ "I finished  │
   │ addr,len,    │   │  requests for │   │  these"      │
   │ flags,next   │   │  you"         │   │              │
   └──────────────┘   └───────────────┘   └──────────────┘
```

- **`desc`** — an array of descriptors, each pointing at a chunk of memory
  (address, length, flags, and a `next` index to chain chunks).
- **`avail`** — the kernel adds the head descriptor index here to say "process
  this."
- **`used`** — the device adds entries here to say "done," and raises an
  interrupt.

A single disk request chains **three** descriptors: one for the request header
(read/write + block number), one for the 1024-byte data buffer, and one for a
status byte the device writes to report success. We model the structures as typed
views over pages from `kalloc` (Chapter 4):

```go
// virtio.go
const NUM = 8 // ring size: NUM outstanding requests

type virtqDesc struct {
	addr  uint64 // physical address of the buffer
	len   uint32
	flags uint16 // VRING_DESC_F_NEXT / _WRITE
	next  uint16 // index of the next descriptor in the chain
}

var disk struct {
	desc  *[NUM]virtqDesc
	avail *[NUM + 2]uint16
	used  *usedRing
	free  [NUM]bool       // which descriptors are unused
	info  [NUM]struct {   // per-request bookkeeping
		b      *buf
		status uint8
	}
	vdisklock spinlock
}
```

---

## 12.3 DMA in a garbage-collected language

This is the Go problem of the chapter. The device performs **DMA** — it reads and
writes the data buffer *directly*, by physical address, without the CPU. Two
hard requirements follow:

- **The buffer's physical address must be stable.** We hand the device a raw
  physical address; if the memory moved (as a compacting GC might do), the device
  would scribble on the wrong page. Our pages come from `kalloc`, which lives
  outside any managed heap (Chapter 4), so they never move — but the discipline is
  explicit: *anything a device touches by DMA must be pinned*.
- **The buffer must not be cached/reordered around the device's access.** The CPU
  and device see the same memory; without care, the CPU could read stale bytes
  from its cache or the compiler could reorder a load before the device finished
  writing. The completion interrupt plus the locking give us the ordering.

In a language with a moving collector you would otherwise need a "pin" API. Our
answer is structural: device buffers are always `kalloc`'d pages addressed by
`uintptr`, never Go-managed objects. The same rule protected page tables (Chapter
5) and trapframes (Chapter 7); here it's not just convenient but *correct* —
violating it would corrupt the disk.

---

## 12.4 Initialization

`virtioDiskInit` performs the virtio handshake: read the device's magic and
version, negotiate features, allocate the three ring pages, tell the device their
physical addresses, and mark the queue ready.

```go
// virtio_disk.go (structure)
func virtioDiskInit() {
	initlock(&disk.vdisklock, "virtio_disk")

	if rdReg(mmioMagic) != 0x74726976 || rdReg(mmioVersion) != 2 {
		panic("could not find virtio disk")
	}
	// … reset, set ACKNOWLEDGE | DRIVER status, negotiate features …

	// Allocate the descriptor table and the avail/used rings (one page each).
	disk.desc = (*[NUM]virtqDesc)(unsafe.Pointer(kalloc()))
	disk.avail = (*[NUM + 2]uint16)(unsafe.Pointer(kalloc()))
	disk.used = (*usedRing)(unsafe.Pointer(kalloc()))
	// … zero them, hand their physical addresses to the device …

	for i := range disk.free {
		disk.free[i] = true // all descriptors start unused
	}
	// … set the DRIVER_OK status bit; the device is live …
}
```

The physical addresses we write into the device's registers are exactly why the
ring pages must be `kalloc`'d (stable physical memory), as §12.3 demands.

---

## 12.5 A request: `virtioDiskRW`

Reading or writing a block builds the three-descriptor chain, publishes it in the
`avail` ring, notifies the device, then **sleeps** until the completion interrupt
fires:

```go
// virtio_disk.go (structure)
func virtioDiskRW(b *buf, write bool) {
	acquire(&disk.vdisklock)

	// 1. Grab three free descriptors (blocking until available).
	idx := allocDesc3()

	// 2. Fill the header: operation + sector number.
	op := &disk.ops[idx[0]]
	if write { op.typ = virtioBlkTOut } else { op.typ = virtioBlkTIn }
	op.sector = uint64(b.blockno) * (BSIZE / 512)

	// 3. desc[0] = header, desc[1] = data buffer, desc[2] = status byte.
	chain(idx, op, b, write)

	// 4. Remember which buf this request belongs to, mark it in flight.
	disk.info[idx[0]].b = b
	b.disk = 1

	// 5. Publish the head in the avail ring and notify the device.
	publish(idx[0])
	wrReg(mmioQueueNotify, 0)

	// 6. Sleep until the interrupt handler clears b.disk.
	for b.disk == 1 {
		sleep(unsafe.Pointer(b), &disk.vdisklock)
	}

	disk.info[idx[0]].b = nil
	freeChain(idx[0])
	release(&disk.vdisklock)
}
```

This is the `sleep`/`wakeup` pattern from Chapter 10 in its natural habitat: the
process blocks on the buffer's address as a channel; the disk works
asynchronously; the interrupt wakes it. While it sleeps, the CPU runs other
processes — exactly the multiplexing the scheduler exists for.

---

## 12.6 The completion interrupt

When the device finishes, it adds entries to the `used` ring and raises an
interrupt. `devintr` (Chapter 7) routes it here. The handler walks the new `used`
entries, marks each buffer done, and wakes the waiting process:

```go
// virtio_disk.go
func virtioDiskIntr() {
	acquire(&disk.vdisklock)

	// Acknowledge the interrupt so the device can raise more.
	wrReg(mmioInterruptAck, rdReg(mmioInterruptStatus)&0x3)

	// Process every newly completed entry in the used ring.
	for disk.usedIdx != disk.used.idx {
		id := disk.used.ring[disk.usedIdx%NUM].id
		if disk.info[id].status != 0 {
			panic("virtio_disk_intr status")
		}
		b := disk.info[id].b
		b.disk = 0                        // mark this request complete
		wakeup(unsafe.Pointer(b))         // wake virtioDiskRW
		disk.usedIdx++
	}
	release(&disk.vdisklock)
}
```

`b.disk = 0` is the condition `virtioDiskRW` was sleeping on; `wakeup` makes the
sleeper `RUNNABLE`. The `usedIdx` cursor lets the handler process exactly the
entries the device added since last time, even if several requests complete at
once.

---

## 12.7 What you should take away

- A block device offers two operations — **read block N**, **write block N** — and
  everything above is built on them.
- **virtio** uses a **virtqueue**: shared `desc`/`avail`/`used` rings. One request
  is a chain of three descriptors (header, data, status).
- **DMA in Go** demands pinned, physically-stable buffers: device memory is always
  `kalloc`'d pages addressed by `uintptr`, never GC-managed objects — here a
  correctness requirement, not a nicety.
- A request **publishes to `avail`, notifies, and sleeps**; the **completion
  interrupt** drains `used`, marks buffers done, and **wakes** the sleeper — the
  Chapter 10 `sleep`/`wakeup` pattern.

---

## Exercises

1. **Three descriptors.** Why does one disk request need three descriptors rather
   than one? What does each carry, and which one does the *device* write?

2. **Stable addresses.** Suppose Go's GC were enabled and could move heap objects.
   Describe exactly what corrupts if the data buffer moved between
   `wrReg(QueueNotify)` and the completion interrupt.

3. **Sleep, don't spin.** Why does `virtioDiskRW` `sleep` rather than poll the
   `used` ring in a loop? What does the CPU do meanwhile, and which earlier chapter
   makes that possible?

4. **Batched completions.** The interrupt handler loops `while usedIdx !=
   used.idx`. Construct a situation where one interrupt completes three requests.
   Why is a single cursor enough?

5. **Ack ordering.** What could go wrong if the handler woke the sleepers *before*
   acknowledging the interrupt to the device? (Think about a second interrupt
   arriving.)

---

*Next: **Chapter 13 — The Buffer Cache**, which sits directly above this driver:
an in-memory cache of disk blocks so the kernel reads each block once, with
per-block sleep locks coordinating concurrent access.*
