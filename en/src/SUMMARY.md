# Summary

[Introduction](introduction.md)
[Chapter 0 — Setting Up Your Toolchain](ch00-setup.md)

# Part I — Foundations

- [What an Operating System Does](ch01-what-an-os-does.md)
- [From Power-On to `main`](ch02-power-on-to-main.md)
- [Talking to Hardware — the Console](ch03-console.md)

# Part II — Memory

- [Physical Memory Allocation](ch04-physical-memory.md)
- [Virtual Memory and Page Tables](ch05-virtual-memory.md)
- [Per-Process Address Spaces](ch06-address-spaces.md)

# Part III — Processes, Traps, and Concurrency

- [Traps, Interrupts, and System Calls](ch07-traps-syscalls.md)
- [The First Process and `exec`](ch08-first-process-exec.md)
- [Locking and Multicore]()
- [Scheduling and Context Switching]()
- [`fork`, `wait`, `exit`, and `kill`]()

# Part IV — File System

- [The Disk Driver]()
- [The Buffer Cache]()
- [Crash Recovery — the Logging Layer]()
- [Inodes and the On-Disk Layout]()
- [Directories and Path Names]()
- [The File Descriptor Layer]()

# Part V — User Space

- [The User Library]()
- [The Shell]()
- [The Userland Utilities]()
- [Testing It All]()

# Part VI — Beyond the Kernel

- [Reflections on Go in a Kernel]()
- [Where to Go Next]()

# Appendices

- [RISC-V Reference]()
- [The Go Freestanding Toolchain]()
- [QEMU and Debugging]()
- [The Memory Map]()
