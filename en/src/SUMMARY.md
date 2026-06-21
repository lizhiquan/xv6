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
- [Locking and Multicore](ch09-locking-multicore.md)
- [Scheduling and Context Switching](ch10-scheduling.md)
- [`fork`, `wait`, `exit`, and `kill`](ch11-fork-wait-exit.md)

# Part IV — File System

- [The Disk Driver](ch12-disk-driver.md)
- [The Buffer Cache](ch13-buffer-cache.md)
- [Crash Recovery — the Logging Layer](ch14-logging.md)
- [Inodes and the On-Disk Layout](ch15-inodes.md)
- [Directories and Path Names](ch16-directories.md)
- [The File Descriptor Layer](ch17-file-descriptors.md)

# Part V — User Space

- [The User Library](ch18-user-library.md)
- [The Shell](ch19-shell.md)
- [The Userland Utilities](ch20-userland-utilities.md)
- [Testing It All](ch21-testing.md)

# Part VI — Beyond the Kernel

- [Reflections on Go in a Kernel](ch22-reflections.md)
- [Where to Go Next](ch23-where-next.md)

# Appendices

- [RISC-V Reference](appendix-a-riscv.md)
- [The Go Freestanding Toolchain]()
- [QEMU and Debugging]()
- [The Memory Map]()
