# Chapter 16 — Directories and Path Names

> Inodes (Chapter 15) give us files, but a file numbered 47 is no use to a human.
> Directories supply names. A directory is just a file whose contents are a list
> of (name, inode-number) pairs — which means we already know how to read and
> write it. This chapter builds directory lookup, the path resolution that turns
> `/usr/bin/sh` into an inode, and the `link`/`unlink` operations that edit the
> name space.
>
> Milestone: create, look up, and remove files by path.

---

## 16.1 A directory is a file

The elegant insight: a **directory** is an ordinary file (inode type `T_DIR`)
whose data is an array of fixed-size **directory entries**. Each entry maps a name
to an inode number; an entry with inode number 0 is free.

```go
// fs.go
const DIRSIZ = 14

type dirent struct {
	inum uint16
	name [DIRSIZ]byte // not necessarily NUL-terminated if exactly 14 chars
}
```

Because a directory's contents live in data blocks like any file's, we read and
write them with the very `readi`/`writei` from Chapter 15 — no new storage
mechanism. The file system is delightfully self-referential: directories are files
that contain references to files (including other directories).

Every directory contains two entries from birth: `.` (itself) and `..` (its
parent), which is how `..` navigation and cycle-free traversal work.

---

## 16.2 `dirlookup`: name → inode

Looking up a name scans the directory's entries for a match:

```go
// fs.go
func dirlookup(dp *inode, name string, poff *uint) *inode {
	if dp.typ != T_DIR {
		panic("dirlookup not DIR")
	}
	var de dirent
	for off := uint(0); off < dp.size; off += uint(unsafe.Sizeof(de)) {
		readi(dp, ptrTo(&de), off, uint(unsafe.Sizeof(de)))
		if de.inum == 0 {
			continue // free slot
		}
		if nameEq(name, de.name[:]) {
			if poff != nil {
				*poff = off // where the entry sits (used by unlink)
			}
			return iget(dp.dev, uint(de.inum)) // an in-memory inode, ref'd
		}
	}
	return nil
}
```

It returns an `iget`'d inode (reference bumped, not yet locked — Chapter 15's
protocol), or `nil` if the name isn't present. Linear scan is fine: xv6
directories are small, and the blocks are cached (Chapter 13).

---

## 16.3 `dirlink`: adding a name

Adding an entry finds a free slot (or extends the directory) and writes the new
(name, inum) pair:

```go
// fs.go
func dirlink(dp *inode, name string, inum uint) int {
	// Refuse duplicates.
	if ip := dirlookup(dp, name, nil); ip != nil {
		iput(ip)
		return -1
	}
	// Find an empty entry (inum == 0), or append at the end.
	var de dirent
	off := uint(0)
	for ; off < dp.size; off += uint(unsafe.Sizeof(de)) {
		readi(dp, ptrTo(&de), off, uint(unsafe.Sizeof(de)))
		if de.inum == 0 {
			break
		}
	}
	copyName(de.name[:], name)
	de.inum = uint16(inum)
	writei(dp, ptrTo(&de), off, uint(unsafe.Sizeof(de))) // through the log
	return 0
}
```

`writei` routes through the logging layer (Chapter 14), so adding a name is part
of a crash-safe transaction — which is why creating a file (inode alloc + bitmap +
this directory write) is all-or-nothing.

---

## 16.4 Path resolution: `namei`

A path like `/usr/bin/sh` is resolved one component at a time, starting from the
root inode (inode 1) for absolute paths or the process's current directory for
relative ones. The helper `skipelem` peels off the next component:

```go
// fs.go
// skipelem("a/bb/c", name) sets name="a" and returns "bb/c".
func skipelem(path string) (elem string, rest string)

func namex(path string, nameiparent bool, name *string) *inode {
	var ip *inode
	if len(path) > 0 && path[0] == '/' {
		ip = iget(ROOTDEV, ROOTINO) // absolute: start at root
	} else {
		ip = idup(myproc().cwd) // relative: start at cwd
	}

	for {
		elem, rest := skipelem(path)
		if elem == "" {
			break
		}
		ilock(ip)
		if ip.typ != T_DIR {
			iunlockput(ip)
			return nil // a path component wasn't a directory
		}
		if nameiparent && rest == "" {
			iunlock(ip) // stop one level early: return the parent
			*name = elem
			return ip
		}
		next := dirlookup(ip, elem, nil)
		if next == nil {
			iunlockput(ip)
			return nil // no such name
		}
		iunlockput(ip)
		ip = next
		path = rest
	}
	return ip
}

func namei(path string) *inode { return namex(path, false, nil) }
func nameiparent(path string, name *string) *inode { return namex(path, true, name) }
```

Two variants matter: `namei` returns the inode of the target; `nameiparent`
returns the *parent* directory and the final component name. Operations that
create or remove a name (`create`, `unlink`) need the parent, so they use
`nameiparent`. The careful `ilock`/`iunlockput` pacing — lock one directory, look
up the next, release the first — walks the tree without ever holding two inode
locks at once, avoiding a class of deadlocks.

---

## 16.5 `link` and `unlink`

A **hard link** is a second directory entry pointing at the same inode. `link(old,
new)` looks up `old`'s inode, bumps its `nlink`, and adds a `new` entry for it —
two names, one file:

```go
// sysfile.go (structure)
func link(old, new string) int {
	beginOp()
	ip := namei(old)            // the existing file
	ilock(ip)
	if ip.typ == T_DIR {        // hard links to directories are forbidden
		iunlockput(ip); endOp(); return -1
	}
	ip.nlink++                  // one more name refers to it
	iupdate(ip)
	iunlock(ip)

	dp := nameiparent(new, &name)
	if dp == nil || dp.dev != ip.dev || dirlink(dp, name, ip.inum) < 0 {
		// roll back the nlink bump on failure
		ilock(ip); ip.nlink--; iupdate(ip); iunlockput(ip)
		endOp(); return -1
	}
	iput(ip)
	endOp()
	return 0
}
```

`unlink` is the reverse: erase the directory entry (write inum 0) and decrement
`nlink`. When `nlink` reaches 0, the file is *eligible* for deletion — but the
actual freeing happens in `iput` (Chapter 15) only when the last open reference
closes:

```go
// sysfile.go (structure)
func unlink(path string) int {
	beginOp()
	dp := nameiparent(path, &name)
	ilock(dp)
	ip := dirlookup(dp, name, &off)  // find the entry and its offset
	ilock(ip)
	if ip.typ == T_DIR && !isEmpty(ip) { // can't remove a non-empty directory
		iunlockput(ip); iunlockput(dp); endOp(); return -1
	}
	zeroEntry(dp, off)               // clear the directory entry
	ip.nlink--
	iupdate(ip)
	iunlockput(ip)                   // iput here frees blocks if nlink==0 and ref==0
	iunlockput(dp)
	endOp()
	return 0
}
```

This is hard links and "deleting an open file keeps working" falling out of the
`nlink`/`ref` split from Chapter 15 — no special cases, just reference counting at
two levels. The whole operation is one transaction, so a crash can't leave a name
pointing at a freed inode.

---

## 16.6 What you should take away

- A **directory is a file** of (name, inode-number) entries; we read/write it with
  `readi`/`writei` — no new storage mechanism.
- Every directory has `.` and `..`; `dirlookup` scans for a name, `dirlink` adds
  one (refusing duplicates), both through the log.
- **Path resolution** (`namei`/`nameiparent`) walks components from root or cwd,
  locking one directory at a time to avoid deadlock; `nameiparent` stops one level
  early for create/remove.
- **`link`** adds a name and bumps `nlink`; **`unlink`** removes a name and
  decrements it — actual deletion is deferred to `iput` via the `nlink`/`ref`
  split.
- Each operation is one **transaction**, so the name space is never left
  inconsistent by a crash.

---

## Exercises

1. **Self-reference.** A directory is a file whose contents reference inodes. What
   prevents infinite recursion when resolving a path, given that `.` and `..` are
   entries too?

2. **Two names, one file.** After `link("/a", "/b")`, what is the inode's `nlink`?
   What happens to the data when you `unlink("/a")` but keep `/b`? When you then
   `unlink("/b")`?

3. **Lock ordering.** `namex` holds at most one inode lock at a time. Construct the
   deadlock that could occur if it locked the next directory *before* releasing the
   current one, with two processes resolving crossing paths.

4. **nameiparent.** Why do `create` and `unlink` use `nameiparent` instead of
   `namei`? What would go wrong trying to add an entry with only the target inode?

5. **Crash mid-link.** Trace `link` and identify every block it writes. Show that
   if a crash occurs after the `nlink++` but before `dirlink`, the logging layer
   leaves the file system consistent (and how the rollback path handles the
   no-crash failure case).

---

*Next: **Chapter 17 — The File Descriptor Layer**, the top of the file system: the
open-file table, `dup`, pipes, device files, and the `open`/`read`/`write`/`close`
syscalls that unify files, pipes, and the console behind one interface.*
