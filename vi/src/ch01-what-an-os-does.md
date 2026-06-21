# Chương 1 — Hệ điều hành làm những gì

> Hết chương này bạn vẫn chưa viết một dòng mã nào — nhưng bạn sẽ biết chính xác
> ta sắp xây dựng cái gì, vì sao phần cứng RISC-V lại có hình hài như vậy, và các
> mảnh ghép của kernel khớp với nhau ra sao. Hãy xem chương này như tấm bản đồ mà
> bạn sẽ còn quay lại nhiều lần.

---

## 1.1 Bài toán mà một hệ điều hành giải quyết

Chạy một chương trình duy nhất trên một cỗ máy trần thì mọi thứ đơn giản: mã của
bạn sở hữu mọi thanh ghi, toàn bộ RAM và mọi thiết bị. Nhưng ngay khi bạn muốn có
chương trình *thứ hai* — hoặc một chương trình bạn không hoàn toàn tin tưởng, hay
một chương trình không được phép làm sập cả cỗ máy — bạn cần ai đó đứng giữa phần
cứng và các chương trình. Người đó chính là **kernel** (nhân hệ điều hành).

Một kernel tồn tại để cung cấp ba thứ:

1. **Cô lập (isolation).** Lỗi hay sự độc hại của một chương trình không được làm
   hỏng bộ nhớ của chương trình khác, hay của chính kernel. Một vòng lặp vô tận
   trong một tiến trình không được đóng băng cả cỗ máy.
2. **Ghép kênh (multiplexing).** Một CPU phải trông như nhiều CPU; RAM hữu hạn
   phải được chia sẻ; một cái đĩa phải chứa nhiều tập tin. Kernel chia nhỏ phần
   cứng theo thời gian và không gian để mỗi chương trình có ảo giác sở hữu trọn
   vẹn nó.
3. **Trừu tượng hóa (abstraction).** Chương trình không nên phải nói chuyện bằng
   ngôn ngữ thanh-ghi-UART hay hàng-đợi-virtio. Chúng chỉ nên nói `write(fd, buf,
   n)` và `open("/path")`. Kernel biến phần cứng lộn xộn thành một tập dịch vụ
   nhỏ gọn, đồng nhất.

Mọi thứ trong cuốn sách này đều phục vụ cho ba từ đó: **cô lập, ghép kênh, trừu
tượng hóa.** Khi một quyết định thiết kế có vẻ tùy tiện, hãy tự hỏi nó mua về cái
nào trong ba thứ ấy. Gần như luôn là một trong số chúng.

---

## 1.2 Ranh giới người dùng/kernel

Phần cứng thực thi sự cô lập bằng **các mức đặc quyền (privilege level)**. RISC-V
có ba mức (chi tiết ở §1.5), nhưng ý tưởng cốt lõi là một thế giới hai phe:

- **Chế độ người dùng (user mode)** — nơi các chương trình thông thường chạy.
  Shell, `ls`, `cat`, mã của bạn. Bị hạn chế: không thể chạm vào bộ nhớ thiết bị,
  không thể sửa bảng trang, không thể tắt ngắt. Nếu nó thử, phần cứng sẽ "trap"
  vào kernel.
- **Chế độ supervisor (supervisor mode)** — nơi kernel chạy. Đặc quyền: thấy toàn
  bộ bộ nhớ vật lý, lập trình bảng trang, nói chuyện với thiết bị, và quyết định
  ai được chạy tiếp theo.

Cách duy nhất để một chương trình người dùng làm một việc cần đặc quyền là *nhờ*
kernel, bằng cách thực thi một lệnh đặc biệt (`ecall` trên RISC-V) cố ý "trap"
vào chế độ supervisor tại một điểm vào cố định do kernel kiểm soát. Cánh cửa được
kiểm soát này chính là **lời gọi hệ thống (system call)**, và nó là giao diện
quan trọng nhất trong toàn bộ hệ thống. Ta xây dựng nó ở Chương 7.

```
        chế độ người dùng                  chế độ supervisor
   ┌─────────────────┐   ecall / trap   ┌──────────────────┐
   │  sh, ls, cat …  │ ───────────────▶ │   kernel         │
   │  (hạn chế)      │ ◀─────────────── │  (đặc quyền)     │
   └─────────────────┘     sret         └──────────────────┘
            ▲                                     │
            │     phần cứng buộc chuyển đổi này   │
            └─────────────────────────────────────┘
                     (trap, ngắt, ecall)
```

Chính phần cứng — không phải kernel — bảo đảm rằng mã người dùng *không thể* vươn
tới chế độ supervisor ngoại trừ qua những cánh cửa mà kernel dựng sẵn. Bảo đảm đó
là nền móng của sự cô lập. Một phần rất lớn mã kernel tồn tại chỉ để quản lý
những lần chuyển đổi này một cách đúng đắn và an toàn.

---

## 1.3 Một vòng tham quan thứ ta sẽ xây

Tới chương cuối, bạn sẽ có một kernel kiểu Unix khởi động trên máy `virt` của
QEMU và chạy một shell tương tác. Cụ thể, nó sẽ:

- khởi động từ lúc bật nguồn, qua chế độ machine, vào chế độ supervisor;
- điều khiển một console UART để nhập và xuất;
- quản lý bộ nhớ vật lý và không gian địa chỉ ảo riêng cho từng tiến trình bằng
  phân trang Sv39;
- xử lý trap, ngắt và lời gọi hệ thống;
- tạo tiến trình và chuyển đổi giữa chúng theo kiểu giành quyền, trên nhiều CPU;
- cài đặt `fork`, `exec`, `wait`, `exit`, `kill`, pipe và file descriptor;
- lưu tập tin trên một hệ thống tập tin an-toàn-trước-sự-cố, có ghi nhật ký, trên
  một đĩa virtio;
- chạy một shell và những tiện ích quen thuộc — `cat`, `echo`, `grep`, `ls`,
  `mkdir`, `rm`, `wc` — cùng một bộ kiểm thử áp lực.

Dưới đây là hệ thống mà ta nhắm tới, phác họa theo các tầng:

```
   ┌──────────────────────────────────────────────────────────┐
   │ người dùng:  sh  ls  cat  grep  usertests       (Phần V)  │
   ├──────────────────────────────────────────────────────────┤
   │ syscall: fork exec wait open read write pipe    (Phần III)│
   ├───────────────┬───────────────┬──────────────────────────┤
   │ tiến trình &  │ hệ thống tập  │ bộ nhớ                    │
   │ lập lịch      │ tin (fd→file→ │ (cấp phát trang, bảng     │
   │ (proc, switch,│  inode→log→   │  trang, không gian địa    │
   │  trap)        │  buffer→đĩa)  │  chỉ người dùng/kernel)   │
   │  Phần III     │  Phần IV      │  Phần II                  │
   ├───────────────┴───────────────┴──────────────────────────┤
   │ boot + console: entry, start, uart, printk      (Phần I)  │
   ├──────────────────────────────────────────────────────────┤
   │ phần cứng: CPU RISC-V, RAM, UART, virtio, PLIC (QEMU virt)│
   └──────────────────────────────────────────────────────────┘
```

Ta xây từ dưới lên, cũng chính là thứ tự kernel tự khởi tạo lúc khởi động (§1.7).

---

## 1.4 Hình hài của kernel

Biết trước mọi thứ sẽ nằm ở đâu sẽ có ích trong mọi chương về sau. Cả kernel rất
nhỏ — vài nghìn dòng Go — nên xuyên suốt cuốn sách, từng mảnh một, bạn sẽ viết về
cơ bản toàn bộ nó. Ta sẽ tổ chức kho mã sao cho mỗi hệ con là một hoặc hai tập
tin có tên rõ ràng.

### `kernel/` — khởi động và thiết lập mức thấp
| Tập tin | Vai trò | Xây ở |
|------|------|----------|
| `entry.s` | những lệnh đầu tiên sau khi QEMU nhảy vào kernel | Ch. 2 |
| `start.go` | thiết lập chế độ machine, rồi hạ xuống supervisor | Ch. 2 |
| `main.go` | `main` ở chế độ supervisor; khởi tạo mọi hệ con | Ch. 2, 1.7 |
| `kernel.ld` | linker script; nơi kernel nằm trong bộ nhớ | Ch. 2 |
| `memlayout.go` | các hằng số bản đồ bộ nhớ vật lý/ảo | Ch. 1, 5 |
| `riscv.go` | truy cập CSR, các bit phân trang, định nghĩa đặc quyền | xuyên suốt |
| `param.go` | giới hạn toàn hệ thống (`NPROC`, `NCPU`, `NBUF`, …) | xuyên suốt |

### `kernel/` — console và thiết bị
| Tập tin | Vai trò | Xây ở |
|------|------|----------|
| `uart.go` | trình điều khiển UART 16550 | Ch. 3 |
| `console.go` | xử lý dòng nhập; console như một tập tin thiết bị | Ch. 3, 17 |
| `printk.go` | bộ in định dạng của kernel | Ch. 3 |
| `plic.go` | bộ điều khiển ngắt mức nền tảng (PLIC) | Ch. 7, 9 |
| `virtio_disk.go` | trình điều khiển thiết bị khối virtio | Ch. 12 |

### `kernel/` — bộ nhớ
| Tập tin | Vai trò | Xây ở |
|------|------|----------|
| `kalloc.go` | bộ cấp phát trang vật lý (free list) | Ch. 4 |
| `vm.go` | bảng trang, không gian địa chỉ kernel & người dùng | Ch. 5, 6 |

### `kernel/` — tiến trình, trap, đồng thời
| Tập tin | Vai trò | Xây ở |
|------|------|----------|
| `proc.go` | bảng tiến trình, bộ lập lịch, fork/wait/exit | Ch. 10, 11 |
| `switch.s` | chuyển ngữ cảnh (lưu/khôi phục thanh ghi callee) | Ch. 10 |
| `trampoline.s` | trampoline trap người dùng↔kernel | Ch. 7 |
| `trap.go`, `kernelvec.s` | xử lý trap (người dùng và kernel) | Ch. 7 |
| `syscall.go` | bảng điều phối lời gọi hệ thống | Ch. 7 |
| `sysproc.go` | cài đặt các syscall liên quan tiến trình | Ch. 11 |
| `spinlock.go`, `sleeplock.go` | hai loại khóa | Ch. 9 |
| `exec.go`, `elf.go` | nạp ELF; biến một tập tin thành tiến trình | Ch. 8 |

### `kernel/` — hệ thống tập tin (từ dưới lên)
| Tập tin | Vai trò | Xây ở |
|------|------|----------|
| `bio.go` | bộ đệm khối trên đĩa | Ch. 13 |
| `log.go` | ghi nhật ký trước-khi-ghi để an toàn trước sự cố | Ch. 14 |
| `fs.go` | superblock, inode, thư mục | Ch. 15, 16 |
| `file.go` | bảng tập tin đang mở, file descriptor | Ch. 17 |
| `pipe.go` | pipe | Ch. 17 |
| `sysfile.go` | các syscall liên quan tập tin | Ch. 17 |

### `user/` — không gian người dùng
| Tập tin | Vai trò | Xây ở |
|------|------|----------|
| `ulib.go`, `printf.go`, `umalloc.go` | thư viện người dùng | Ch. 18 |
| `sh.go` | shell | Ch. 19 |
| `cat.go`, `echo.go`, `grep.go`, `ls.go`, … | tiện ích | Ch. 20 |
| `usertests.go`, `forktest.go`, … | bộ kiểm thử | Ch. 21 |

Bạn chưa cần hiểu gì trong số này cả — bạn chỉ cần biết các mảnh ghép tồn tại và
mỗi hệ con nằm đại khái ở đâu. Ta sẽ liên tục quay lại bảng này.

---

## 1.5 RISC-V trong ba mươi phút

Bạn không cần là chuyên gia RISC-V, nhưng kernel chạm vào kiến trúc này liên tục.
Đây là phần tối thiểu cần biết.

### Các thanh ghi
Có 32 thanh ghi số nguyên đa dụng 64-bit, `x0`–`x31`, với tên theo quy ước:

- `x0` / `zero` — luôn bằng không (đấu cứng).
- `ra` (`x1`) — địa chỉ trả về (return address).
- `sp` (`x2`) — con trỏ ngăn xếp (stack pointer).
- `gp`, `tp` — con trỏ toàn cục / con trỏ luồng (`tp` ta dùng để giữ id của CPU).
- `a0`–`a7` — thanh ghi đối số / giá trị trả về. **Đối số của lời gọi hệ thống đi
  vào đây**, và `a7` mang số hiệu syscall.
- `t0`–`t6` — thanh ghi tạm (caller-saved).
- `s0`–`s11` — thanh ghi được giữ (callee-saved). **Chuyển ngữ cảnh lưu đúng
  những thanh ghi này** (Ch. 10).

Cộng thêm bộ đếm chương trình `pc`. Sự phân chia caller/callee-saved không phải
chuyện vặt: nó chính là lý do chuyển ngữ cảnh chỉ phải lưu `s0`–`s11`, `sp` và
`ra`.

### Ba mức đặc quyền
RISC-V định nghĩa ba mức, từ nhiều đặc quyền nhất đến ít nhất:

| Mức | Tên | Ai chạy ở đây |
|------|------|---------------|
| **M** | Machine | firmware / lúc khởi động sớm nhất; toàn quyền phần cứng |
| **S** | Supervisor | kernel của ta |
| **U** | User | các chương trình ứng dụng |

Ta khởi động ở **chế độ M** (đặc quyền cao nhất), làm phần thiết lập mức-machine
tối thiểu, rồi lập tức hạ xuống **chế độ S** để chạy kernel — phần lớn hệ điều
hành sống ở S. Các chương trình người dùng chạy ở **chế độ U** và "trap" lên S
khi cần kernel. Dòng chảy M→S→(U⇄S) này là xương sống của Chương 2 và 7.

Đây là phần tinh tế của bước hạ M→S, mà ta sẽ cài đặt ở Chương 2. Không có lệnh
nào để *vào* trực tiếp một mức đặc quyền thấp hơn. Thay vào đó, bạn đặt một trường
trong thanh ghi trạng thái machine (`mstatus`) ghi rằng "mức trước đó là
Supervisor", trỏ bộ đếm ngoại lệ machine (`mepc`) vào `main` của ta, và thực thi
`mret` — một lệnh *trở về từ trap*. Phần cứng ngoan ngoãn "trở về" vào chế độ S
tại `main`, dù chẳng có trap nào từng xảy ra. Ta giả vờ một lần trở về để vào
được mức ta muốn.

### CSR — các thanh ghi điều khiển và trạng thái
Các mức được cấu hình thông qua **CSR**, những thanh ghi đặc biệt được đọc và ghi
bằng các lệnh chuyên dụng (`csrr`/`csrw`). Bạn sẽ gặp một dàn nhân vật lặp đi lặp
lại:

- `mstatus` / `sstatus` — trạng thái hiện tại, gồm cả trường mức-đặc-quyền-trước.
- `mepc` / `sepc` — địa chỉ PC để tiếp tục khi trở về từ trap.
- `stvec` — địa chỉ trình xử lý trap của kernel (Ch. 7).
- `scause` / `stval` — vì sao trap xảy ra và giá trị gây lỗi (Ch. 7).
- `satp` — bảng trang đang hoạt động (Ch. 5). Ghi vào nó là bật phân trang.

Vì Go không thể tự phát ra lệnh `csrw`, ta bọc mỗi CSR trong một stub assembly nhỏ
và gọi nó như một hàm bình thường. Ví dụ, hàm truy cập để cài bảng trang trông như
sau (nửa assembly nằm trong một tập tin `.s`; Phụ lục B giải thích cơ chế):

```go
// riscv.go
func w_satp(x uint64) // cài đặt trong riscv.s là: csrw satp, a0; ret
```

Điểm cần nhớ lúc này: **một lần ghi CSR là cách kernel tự cấu hình lại chính
CPU**, và chỉ có khoảng hai chục CSR là quan trọng.

### Cơ chế trap, gói trong một đoạn
Khi xảy ra một lời gọi hệ thống, một ngoại lệ, hay một ngắt thiết bị, phần cứng
sẽ: lưu PC hiện tại vào `sepc`, ghi lý do vào `scause`, chuyển sang chế độ S, và
nhảy tới địa chỉ trong `stvec`. Trình xử lý của kernel lưu nốt các thanh ghi còn
lại, làm việc của nó, rồi thực thi `sret`, lệnh này khôi phục PC từ `sepc` và hạ
trở lại mức trước đó. Mọi lời gọi hệ thống, mọi nhịp đồng hồ, mọi ngắt đĩa đều
chảy qua cơ chế duy nhất này. Ta cài đặt nó ở Chương 7; rất đáng đọc lại đoạn này
khi tới đó.

---

## 1.6 Vì sao chọn Go — và cái giá phải trả

Viết một kernel bằng Go cho ta nhìn các khái niệm hệ điều hành một cách rõ ràng,
không bị nhiễu bởi việc quản lý bộ nhớ thủ công và đám con trỏ thường làm rối mã
mức thấp. Ta có một hệ kiểu thực thụ, slice và string, `defer`, và xử lý lỗi gọn
gàng.

Nhưng một kernel vi phạm gần như mọi thứ mà *runtime* của Go giả định. Runtime
chuẩn của Go kỳ vọng có một hệ điều hành *bên dưới nó*: nó xin hệ điều hành đó cấp
bộ nhớ, tạo luồng hệ điều hành, cài trình xử lý tín hiệu, và chạy một bộ thu gom
rác chặn lại để chờ hệ điều hành. Trong một kernel, **chúng ta chính là cái bên
dưới đó** — chẳng có hệ điều hành nào để gọi. Sự căng thẳng này là một mạch xuyên
suốt, và ta sẽ nói thẳng về nó mỗi khi nó cắn ta. Những cái lớn nhất:

- **Ban đầu, không có runtime (Ch. 2).** Ta khởi động với một bộ công cụ
  freestanding (một build kiểu TinyGo hoặc đã lược bớt), tự cung cấp vài ký hiệu
  runtime mà trình biên dịch cần, và tắt bộ thu gom rác cùng bộ lập lịch goroutine
  cho đến khi ta xây xong những thứ nguyên thủy mà chúng cần.
- **Thu gom rác bên trong kernel (Ch. 4, 10, 12).** Một bộ thu gom có thể tạm
  dừng việc thực thi tại bất kỳ lần cấp phát nào là một hiểm họa trong trình xử
  lý ngắt, bộ lập lịch và các đường DMA. Ta giữ những đường đó **không cấp phát**,
  đặt heap trên một vùng vật lý cố định tự quản lý bằng tay, và "ghim" bất kỳ bộ
  nhớ nào mà thiết bị đọc hoặc ghi.
- **`unsafe` và các pragma (Phụ lục B).** Bảng trang, trapframe và thanh ghi thiết
  bị chỉ là những "khung nhìn" có kiểu trên các địa chỉ vật lý. Ta sẽ dựa vào
  `unsafe.Pointer`, và các pragma của trình biên dịch như `//go:nosplit` (bỏ qua
  kiểm tra mở rộng ngăn xếp — tối quan trọng khi vào trap), `//go:noescape` và
  `//go:linkname`.
- **Goroutine *không phải* là tiến trình của ta (Ch. 10).** Rất hấp dẫn khi ánh
  xạ một tiến trình kernel sang một goroutine. Ta cố tình không làm vậy: ta tự xây
  cơ chế chuyển ngữ cảnh bằng assembly, vì một bộ lập lịch kernel phải kiểm soát
  chính xác khi nào và ở đâu một lần chuyển xảy ra. Chương đó giải thích lựa chọn
  này đầy đủ.

Hãy đọc điều này như một tính năng, chứ không phải lời cảnh báo. Mỗi chỗ Go chống
lại ta là một chỗ mà giao kèo giữa phần cứng và hệ điều hành đang lộ ra — đúng
thứ bạn đến đây để học.

---

## 1.7 Hình hài của hành trình: thứ tự khởi động = thứ tự xây dựng

Đây là phần thanh lịch. Hàm `main` của một kernel khởi tạo các hệ con của nó theo
thứ tự phụ thuộc — bạn không thể có bảng tiến trình trước khi cấp phát được bộ
nhớ, không thể cấp phát bộ nhớ kernel trước khi có phân trang, và cứ thế. Chính
thứ tự khởi tạo đó *là* thứ tự ta xây dựng cuốn sách. Đây là hàm `main` ta đang
hướng tới, phác bằng Go:

```go
// kernel/main.go — chạy trên CPU 0 sau khi hạ M→S
func main() {
    if cpuid() == 0 {
        consoleInit()     // Ch. 3  — UART + console
        printkInit()      // Ch. 3  — bộ in của kernel
        kInit()           // Ch. 4  — bộ cấp phát trang vật lý
        kvmInit()         // Ch. 5  — tạo bảng trang của kernel
        kvmInitHart()     // Ch. 5  — bật phân trang
        procInit()        // Ch. 10 — bảng tiến trình
        trapInit()        // Ch. 7  — vector trap
        trapInitHart()    // Ch. 7  — cài vector trap của kernel
        plicInit()        // Ch. 7/9 — bộ điều khiển ngắt
        plicInitHart()    // Ch. 7/9 — xin PLIC các ngắt thiết bị
        binit()           // Ch. 13 — bộ đệm khối
        iinit()           // Ch. 15 — bảng inode
        fileInit()        // Ch. 17 — bảng tập tin
        virtioDiskInit()  // Ch. 12 — đĩa mô phỏng
        userInit()        // Ch. 8  — tiến trình người dùng đầu tiên
    } else {
        // các CPU khác chờ, rồi tự bật phân trang và trap cho mình
    }
    scheduler()           // Ch. 10 — không bao giờ trở về
}
```

Mỗi dòng, đại khái, là một chương. Bằng cách đi theo đúng trình tự khởi động của
chính kernel, ta bảo đảm rằng mọi thứ một chương cần đều đã tồn tại sẵn, và rằng
ở cuối mỗi chương ta có một kernel *khởi động được và làm được nhiều hơn một chút
so với trước*. Tính chất "luôn chạy được" đó là nhịp tim của cuốn sách này.

Xương sống phụ thuộc, lấy từ phần dàn ý:

```
boot → console → kalloc → vm → trap/syscall → exec/init
     → locks → scheduler → fork/wait
     → disk → bio → log → inode → dir → file
     → ulib → sh → utils → tests
```

---

## 1.8 Bản đồ bộ nhớ bạn sẽ sống trong đó

Một định hướng cuối. Máy `virt` của QEMU — phần cứng của ta — đặt các thiết bị và
RAM tại những địa chỉ vật lý cố định. Cả kernel được viết dựa trên bản đồ này:

```
0x00001000  ROM khởi động (QEMU)    ← CPU bắt đầu thực thi ở đây lúc bật nguồn
0x02000000  CLINT  (timer, IPI)
0x0C000000  PLIC   (ngắt thiết bị)
0x10000000  UART0  (console)        ← Ch. 3 ghi ký tự vào đây
0x10001000  đĩa virtio              ← Ch. 12 đọc/ghi các khối ở đây
0x80000000  RAM bắt đầu; QEMU nạp kernel của ta vào đây rồi nhảy vào  ← Ch. 2
   …        mã/dữ liệu kernel, rồi tới vùng cấp phát trang
0x88000000  PHYSTOP (RAM bắt đầu + 128 MiB) — hết phần RAM ta dùng
```

Hai sự thật cần ghi nhớ ngay:

- **CPU bắt đầu thực thi tại `0x1000`** trong ROM khởi động của QEMU, rồi ROM này
  bàn giao cho kernel của ta tại **`0x80000000`**. Chương 2 là câu chuyện về những
  lệnh đầu tiên ấy.
- **Thanh ghi thiết bị chỉ là bộ nhớ.** Ghi một byte vào `0x10000000` sẽ gửi một
  ký tự ra UART. Không có lệnh "I/O" thần kỳ nào — *I/O ánh xạ bộ nhớ
  (memory-mapped I/O)* nghĩa là thiết bị nằm ngay trong không gian địa chỉ, và
  điều khiển phần cứng chỉ là các lệnh load/store tới đúng địa chỉ. Đó là lý do
  Chương 3 có thể là một trình điều khiển thiết bị thực thụ chỉ trong vài chục
  dòng.

Cùng bản đồ bộ nhớ này cũng định nghĩa *phần trên cùng* của không gian địa chỉ ảo
— trang trampoline, các ngăn xếp kernel riêng cho từng tiến trình có trang canh
chen giữa, và trapframe — nhưng những thứ đó chỉ có nghĩa khi ta đã có phân trang
(Ch. 5) và trap (Ch. 7), nên ta sẽ quay lại ở đó.

---

## 1.9 Điều bạn nên mang theo

- Một hệ điều hành tồn tại để mang lại **cô lập, ghép kênh và trừu tượng hóa**;
  hãy đánh giá mọi lựa chọn thiết kế theo việc nó phục vụ cái nào.
- **Ranh giới người dùng/kernel** được phần cứng thực thi bằng **các mức đặc
  quyền**, và **lời gọi hệ thống** là cánh cửa hợp lệ duy nhất giữa chúng.
- RISC-V cho ta ba mức (M/S/U); ta khởi động ở M, chạy kernel ở S, chạy chương
  trình ở U, và di chuyển giữa chúng qua **trap** và **CSR**.
- Ta sẽ xây kernel **từ dưới lên, theo đúng thứ tự khởi động của chính kernel**,
  để nó chạy được ở mọi bước.
- Viết nó bằng **Go** soi sáng được nhiều điều chính vì kernel phá vỡ các giả định
  của runtime Go; mỗi xung đột lại dạy ta về giao kèo phần cứng/hệ điều hành.
- Mọi thứ đều neo vào **bản đồ bộ nhớ của máy `virt` QEMU**, nơi ngay cả thiết bị
  cũng chỉ là những địa chỉ.

---

## Bài tập

1. **Ba nhiệm vụ.** Với mỗi tính năng kernel sau, hãy nói nó chủ yếu phục vụ cái
   nào: cô lập / ghép kênh / trừu tượng hóa: (a) bảng trang, (b) ngắt định thời
   của bộ lập lịch, (c) các lời gọi hệ thống `read`/`write`, (d) quy tắc rằng chế
   độ người dùng không được tắt ngắt. Một số phục vụ nhiều hơn một.

2. **Cú trở về giả.** Bằng lời của bạn, hãy giải thích vì sao việc vào chế độ
   supervisor lại được làm như một lần *trở về từ trap* (`mret`) thay vì một cú
   nhảy trực tiếp. Điều gì sẽ hỏng nếu phần cứng *thực sự* cho phép bạn nhảy thẳng
   vào một mức ít đặc quyền hơn? (Gợi ý: §1.5, và hãy nghĩ về sự cô lập.)

3. **I/O ánh xạ bộ nhớ.** Dùng bản đồ bộ nhớ ở §1.8, bạn sẽ ghi một byte vào địa
   chỉ vật lý nào để gửi một ký tự ra console? Bạn kỳ vọng điều gì xảy ra nếu một
   chương trình *ở chế độ người dùng* thử ghi trực tiếp vào địa chỉ đó, và việc
   ngăn chặn nó phục vụ cái nào trong ba nhiệm vụ của hệ điều hành?

4. **Caller so với callee saved.** Liệt kê các thanh ghi mà chuyển ngữ cảnh sẽ cần
   lưu ở Chương 10, dựa trên các quy tắc quy ước gọi hàm ở §1.5. Vì sao nó không
   cần lưu `a0`–`a7` hay `t0`–`t6`?

5. **Cái giá của Go.** Chọn một trong bốn xung đột Go/kernel ở §1.6 và viết một
   đoạn dự đoán *chỗ nào* trong thứ tự khởi động (§1.7) nó sẽ gây rắc rối lần đầu.
   Ta sẽ kiểm chứng dự đoán của bạn ở chương tương ứng.

---

*Tiếp theo: **Chương 2 — Từ lúc bật nguồn đến `main`**, nơi ta viết những lệnh
đầu tiên CPU chạy, hạ từ chế độ machine xuống supervisor, dựng một kernel Go không
có runtime bên dưới, và in ra dòng đầu tiên qua UART.*
