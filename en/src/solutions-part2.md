# Solutions — Part II (Memory)

> Answers to the exercises in Chapters 4–6.

---

## Chapter 4 — Physical Memory Allocation

**1. Why page-align the check?** `kfree` panics on `pa % PGSIZE != 0`. A bug it
catches: freeing an interior pointer (e.g. a `kalloc`'d page plus an offset). If
the check were gone, that misaligned address would be linked into the free list;
a later `kalloc` would hand out a "page" straddling two real pages, silently
corrupting whatever lived in the second one.

**2. The two junk values.** `kfree` fills with `1`, `kalloc` with `5`, so the two
failure modes are distinguishable in a crash dump. The `1`-fill catches
**use-after-free** (code still reading a page it returned); the `5`-fill catches
**use-before-init** (code reading a freshly allocated page it forgot to
initialize). Same value for both would make the two bugs indistinguishable.

**3. Lock contention.** A **per-CPU free list** lets each CPU allocate/free without
touching a shared lock in the common case. The new problem is **balancing**: a CPU
that frees a lot and allocates little hoards pages while another starves, so you
need a steal/refill policy (when a CPU's list is empty, take a batch from a global
list or another CPU's), which reintroduces some shared synchronization.

**4. Leak detector.** If you allocate N and free only N−1, the second drain should
yield **one fewer page** than the first. That one missing page proves a leak: it
was never returned to the free list, so it's permanently lost.

**5. Order matters.** `kvmInit` calls `kalloc` to get pages for the kernel page
table. If `kInit` hadn't run first, the free list would be empty and `kalloc`
returns 0; `kvmInit` would dereference a null page and crash (or `mappages`
fails). Symptom: a fault/panic during early VM setup, before paging is on.

---

## Chapter 5 — Virtual Memory and Page Tables

**1. Count the tables.** The root (level-2) table already exists (it was allocated
when the address space was created). Mapping one page at VA 0 makes `walk`
allocate the **level-1** and **level-0** tables → **2** new page-table pages (the
leaf PTE lives in that level-0 table). VA `0x40000000` has L2 index
`0x40000000 >> 30 = 1`, different from VA 0's L2 index 0, so it descends a fresh
slot of the existing root and allocates a **new level-1 and level-0** → **2 more**
tables. (Verify by computing the L2/L1/L0 index fields of each address.)

**2. Permission bug.** Mapping kernel code with `pteW` added makes the code region
writable, so you lose **W^X protection**: a stray write (or an attacker who gains
a write primitive) can modify kernel instructions. One-line bug:
`*(*byte)(unsafe.Pointer(KERNBASE)) = 0x90` would now silently overwrite the first
byte of kernel code instead of faulting.

**3. The fence.** Removing the second `sfenceVMA()` leaves stale TLB entries from
before `satp` changed; the CPU might translate an address using the old mapping —
e.g. reading a page that's no longer mapped, or with old permissions. The *first*
fence is needed too: it orders the page-table memory writes before the `satp`
switch, so the MMU sees a fully-built table.

**4. Why direct-map the kernel.** Right after `w_satp`, the CPU fetches the next
instruction at virtual address P (where the code physically lives). With a direct
map, virtual P → physical P, so the fetch lands on the same instruction and
execution continues. If `KERNBASE` mapped elsewhere, virtual P would translate to
a *different* physical page (garbage), and the CPU would execute nonsense or fault
immediately — the classic "triple fault on enabling paging."

**5. MAXVA.** Sv39 requires the unused high bits of a virtual address to be a
sign-extension of bit 38; using the very top of the range risks addresses the
hardware rejects as non-canonical. Keeping `MAXVA` one bit below the max avoids
ever producing such an address (and leaves the trampoline/trapframe region clean).

---

## Chapter 6 — Per-Process Address Spaces

**1. Guard page.** Overflowing the stack into the unmapped guard page causes a
**page fault** (no valid PTE). A fault is far better than the alternative —
silently overwriting whatever lay below the stack — because it turns a subtle
corruption into an immediate, localized crash the kernel can report or kill the
process for.

**2. The boundary bug.** Writing `*userPtr = pid` directly: (a) the user pointer
isn't mapped in the *kernel* page table, so the kernel either writes the wrong
memory or faults; (b) a malicious program can pass a pointer to *kernel* or
*another process's* memory (or a read-only page), tricking the kernel into writing
there — a privilege escalation. The fix is `copyout`, which translates and checks.

**3. Straddling pages.** A 10-byte `copyout` to `0x2FFB` (5 bytes before the
`0x3000` boundary): iteration 1 copies **5** bytes (to fill page ending at
`0x3000`), iteration 2 copies the remaining **5** bytes into the next page. **2**
iterations, because the two halves may be in non-contiguous physical pages.

**4. Rollback.** On a failed `mappages`, you must `kfree` the page you just
allocated (it's mapped nowhere, so nothing else will free it → leak) *and*
`uvmDealloc` the earlier pages (they're mapped and would otherwise stay allocated
in a half-built address space). Skipping the `kfree` leaks one page; skipping
`uvmDealloc` leaks all the earlier ones and leaves a partially-grown space.

**5. Eager vs. lazy.** `fork` then immediate `exec`: `uvmCopy` duplicates every
page of the parent (say a few hundred KB to MB), all of which `exec` throws away
microseconds later — pure waste proportional to the parent's size.
**Copy-on-write** (Chapter 23) avoids it by sharing pages read-only until a write
faults; the trade-off is added page-fault handling and per-page reference counting.

---

*Next: [Solutions — Part III](solutions-part3.md).*
