# Chương 2 — Từ lúc bật nguồn đến `main`

> Đây là chương đầu tiên có mã thật. Ta sẽ viết những lệnh đầu tiên CPU chạy, cấp
> cho mỗi CPU một stack, làm phần thiết lập mức-machine tối thiểu, hạ từ chế độ
> machine xuống chế độ supervisor, và tới được một hàm `main` viết bằng Go in ra
> một dòng qua UART. Hết chương, bạn sẽ có một ảnh kernel khởi động được dưới QEMU
> và chào "hello".
>
> Cột mốc: `make qemu` khởi động và in lời chào từ một kernel Go chạy trên RISC-V
> trần — không có hệ điều hành nào bên dưới nó.

---

## 2.1 "Boot" nghĩa là gì trên máy `virt`

Khi bạn chạy QEMU với `-kernel kernel.elf`, ba việc xảy ra trước khi bất kỳ dòng
mã nào của ta chạy:

1. QEMU nạp kernel của ta vào RAM tại địa chỉ vật lý **`0x80000000`** (điểm bắt
   đầu của RAM trên máy `virt` — xem Chương 1, §1.8).
2. Nó đặt mọi CPU — mọi **hart**, theo thuật ngữ RISC-V — vào **chế độ machine**
   (M-mode), mức đặc quyền cao nhất.
3. Nó khiến mọi hart nhảy tới `0x80000000` và bắt đầu thực thi.

Vậy nên thứ nằm ở `0x80000000` là thứ đầu tiên chạy, trên *mọi* CPU, ở mức đặc
quyền cao nhất, với **không stack, không runtime, không gì cả**. Toàn bộ nhiệm vụ
của ta trong chương này là đi từ trạng thái trần trụi đó tới một hàm Go bình
thường chạy ở chế độ supervisor.

Con đường ngắn và đáng thuộc lòng:

```
1. bật nguồn    — mọi hart khởi động ở M-mode; QEMU nhảy tới 0x80000000
2. _entry (asm) — cấp cho hart này một stack, rồi call start
3. start  (Go)  — thiết lập M-mode; trỏ mepc vào main; thực thi mret
4. main   (Go)  — giờ đã ở S-mode; in dòng đầu tiên ra UART
```

Hai trong bốn bước này là assembly (`_entry`) và các thao tác CSR (`start`); phần
còn lại là Go thông thường. Hãy xây chúng từ dưới lên.

---

## 2.2 Linker script: đặt `_entry` tại `0x80000000`

QEMU nhảy tới `0x80000000` vô điều kiện, nên byte đầu tiên của kernel *bắt buộc*
phải là mã entry của ta. Trình biên dịch và trình liên kết không biết điều đó — ta
nói cho chúng bằng một **linker script**, `kernel.ld`:

```ld
OUTPUT_ARCH( "riscv" )
ENTRY( _entry )

SECTIONS
{
  /* -kernel của QEMU nhảy vào đây, nên _entry phải nằm đúng tại 0x80000000. */
  . = 0x80000000;

  .text : {
    *(.text._entry)     /* đoạn entry của ta, đặt trước tiên */
    *(.text .text.*)    /* rồi tới phần mã còn lại */
    . = ALIGN(0x1000);
    PROVIDE(etext = .);
  }

  .rodata : { . = ALIGN(16); *(.rodata .rodata.*) }
  .data   : { . = ALIGN(16); *(.data .data.*) *(.sdata .sdata.*) }
  .bss    : { . = ALIGN(16); *(.bss .bss.*) *(.sbss .sbss.*) }

  PROVIDE(end = .);   /* địa chỉ trống đầu tiên sau kernel — dùng ở Ch. 4 */
}
```

Ba điểm cần để ý:

- `ENTRY(_entry)` và `. = 0x80000000` cùng nhau bảo đảm ký hiệu `_entry` của ta là
  lệnh đầu tiên tại địa chỉ QEMU nhảy vào.
- `PROVIDE(end = .)` phơi ra một ký hiệu đánh dấu byte trống đầu tiên *sau* kernel.
  Bộ cấp phát trang vật lý ở Chương 4 bắt đầu phát bộ nhớ từ đó.
- Bản build phải dùng mô hình mã **medany** (`-mcmodel=medany`) để mã được liên
  kết tại `0x8000_0000` có thể địa chỉ hóa các ký hiệu bằng lệnh tương đối theo
  PC. Với TinyGo, điều này đặt trong phần mô tả đích (Phụ lục B).

---

## 2.3 `entry.s`: một stack cho mỗi hart

Go không thể chạy nếu không có stack — ngay cả lời gọi hàm đầu tiên cũng đẩy một
địa chỉ trả về vào stack. Nhưng lúc bật nguồn chưa có con trỏ stack nào được dựng.
Vậy nên việc duy nhất phần assembly entry của ta *bắt buộc* làm trước khi gọi bất
kỳ mã Go nào là trỏ `sp` vào một vùng nhớ.

Ta dành riêng một khối nhớ, mỗi CPU một stack kích thước cố định, và tính phần
stack của hart này từ id của nó:

```asm
# entry.s — mã đầu tiên chạy, được kernel.ld đặt tại 0x80000000
.section .text._entry
.global _entry
_entry:
        # sp = stack0 + (hartid + 1) * STACKSIZE
        la   sp, stack0
        li   a0, 4096            # STACKSIZE: 4096 byte cho mỗi hart
        csrr a1, mhartid         # ta là CPU nào?
        addi a1, a1, 1
        mul  a0, a0, a1
        add  sp, sp, a0
        call start               # vào Go (start.go)
spin:
        j spin                   # start() không bao giờ trở về; lặp phòng hờ
```

`stack0` là một mảng liền mạch; hart 0 nhận các byte `[0, 4096)`, hart 1 nhận
`[4096, 8192)`, và cứ thế. Ta cộng `(hartid+1)*STACKSIZE` vì stack lớn lên theo
hướng *đi xuống* — `sp` phải bắt đầu ở *đỉnh* phần stack của hart này.

Ta khai báo vùng nhớ nền bằng Go để kích thước bám theo `NCPU` ở một chỗ duy nhất:

```go
// start.go
package kernel

import "unsafe"

const STACKSIZE = 4096

// Một stack cho mỗi CPU. entry.s trỏ sp vào mảng này trước khi bất kỳ mã Go nào chạy.
// Phơi ra cho assembly dưới ký hiệu liên kết "stack0".
//
//go:export stack0
var stack0 [STACKSIZE * NCPU]byte
```

> **Vì sao phải dùng assembly?** Đây là hàm duy nhất chạy *mà chưa có* một stack
> dùng được, nên nó không thể là Go — trình biên dịch giả định `sp` hợp lệ khi vào
> mọi hàm. Mười một lệnh assembly mua cho ta một stack; mọi thứ sau đó là Go.

---

## 2.4 Vấn đề runtime của Go, nói cho cụ thể

Đây là chỗ lời cảnh báo ở Chương 1 (§1.6) trở thành thực tế. Một chương trình Go
bình thường không bao giờ bắt đầu ở `main` của *bạn*. Nó bắt đầu trong runtime —
runtime này xin hệ điều hành cấp bộ nhớ, tạo luồng, cài trình xử lý tín hiệu, *rồi
mới* gọi `main` của bạn. Ta chẳng có hệ điều hành nào để xin. Nếu để runtime chuẩn
khởi động, nó sập ngay lập tức.

Vậy nên ta biên dịch bằng **TinyGo** và tắt runtime đi:

```jsonc
// riscv-virt.json — một đích TinyGo tùy biến (bản đầy đủ ở Phụ lục B)
{
  "llvm-target":  "riscv64-unknown-elf",
  "cpu":          "generic-rv64",
  "features":     "+m,+a,+c",
  "build-tags":   ["xv6", "baremetal"],
  "gc":           "none",          // không có bộ thu gom rác
  "scheduler":    "none",          // không có bộ lập lịch goroutine
  "linker":       "ld.lld",
  "ldflags":      ["-T", "kernel.ld"],
  "code-model":   "medany"
}
```

`gc: none` và `scheduler: none` là hai dòng quan trọng: chúng bảo TinyGo phát ra
mã không bao giờ cấp phát trên heap có quản lý và không bao giờ cố lập lịch
goroutine — cả hai thứ đó đều chưa tồn tại. (Ta sẽ tự tay xây cả hai ở các chương
sau: bộ cấp phát ở Chương 4, cơ chế chuyển ngữ cảnh của riêng ta ở Chương 10.)

TinyGo vẫn phát ra một mẩu runtime nhỏ muốn gọi một hàm tên `main`. Ta tự thỏa mãn
nó: `_entry` của ta gọi `start`, và `start` trao quyền điều khiển cho `main` của
ta. Ta không bao giờ dùng đường khởi động của TinyGo.

---

## 2.5 `start()`: thiết lập mức machine, bằng Go

`_entry` gọi `start` khi vẫn còn ở **chế độ machine**. M-mode chạm được vào mọi
thứ, nhưng ta muốn ở đây càng ít càng tốt — phần kernel chính chạy ở chế độ
supervisor. `start` cấu hình vài thứ mức-machine mà *chỉ có thể* đặt từ M-mode,
rồi thực hiện cú hạ xuống S-mode.

Trước hết, các hàm truy cập CSR. Go không tự phát được `csrr`/`csrw`, nên mỗi cái
là một stub assembly một dòng, gọi như một hàm bình thường:

```go
// riscv.go — truy cập thanh ghi điều khiển/trạng thái (phần thân ở riscv_asm.s)
func r_mstatus() uint64
func w_mstatus(x uint64)
func w_mepc(x uint64)
func w_satp(x uint64)
func w_medeleg(x uint64)
func w_mideleg(x uint64)
func r_sie() uint64
func w_sie(x uint64)
func w_pmpaddr0(x uint64)
func w_pmpcfg0(x uint64)
func r_mhartid() uint64
func w_tp(x uint64)
```

```asm
# riscv_asm.s — mỗi hàm truy cập một stub; đối số/giá trị trả về ở a0
.global r_mstatus
r_mstatus:  csrr a0, mstatus
            ret
.global w_mstatus
w_mstatus:  csrw mstatus, a0
            ret
.global w_mepc
w_mepc:     csrw mepc, a0
            ret
# … một cặp tương ứng cho mỗi CSR ở trên …
```

Giờ tới chính `start`. Nó phản chiếu từng bước quá trình dựng mức-machine của một
kernel thật:

```go
// start.go
package kernel

// Các bit của mstatus chọn mức đặc quyền mà mret sẽ trở về.
const (
	mstatusMPPMask = 3 << 11 // trường "mức đặc quyền trước"
	mstatusMPPS    = 1 << 11 // = Supervisor
	sieSEIE        = 1 << 9  // ngắt ngoài (external) của supervisor
	sieSTIE        = 1 << 5  // ngắt định thời (timer) của supervisor
	sieSSIE        = 1 << 1  // ngắt phần mềm (software) của supervisor
)

//go:export start
func start() {
	// 1. Bảo mret trở về chế độ supervisor.
	x := r_mstatus()
	x &^= mstatusMPPMask
	x |= mstatusMPPS
	w_mstatus(x)

	// 2. Bảo mret "trở về" tại lệnh nào: main của ta.
	w_mepc(mainPC())

	// 3. Phân trang đang tắt; main sẽ bật nó ở Chương 5.
	w_satp(0)

	// 4. Định tuyến mọi trap về chế độ supervisor thay vì machine.
	w_medeleg(0xffff)
	w_mideleg(0xffff)
	w_sie(r_sie() | sieSEIE | sieSTIE | sieSSIE)

	// 5. Physical Memory Protection: cho S-mode chạm tới toàn bộ RAM.
	w_pmpaddr0(0x3fffffffffffff)
	w_pmpcfg0(0xf)

	// 6. Thiết lập ngắt định thời (chi tiết bên dưới).
	timerInit()

	// 7. Cất id của hart này vào tp để cpuid() đọc về sau.
	w_tp(r_mhartid())

	// 8. "Trở về" chế độ supervisor tại main. Không quay lại.
	mret()
}
```

Đi qua tám bước:

1. **MPP = Supervisor.** Lệnh `mret` trở về mức đặc quyền mà trường `MPP` của
   `mstatus` chỉ định. Ta đặt nó thành Supervisor.
2. **mepc = main.** `mret` nhảy tới địa chỉ trong `mepc`. Ta trỏ nó vào `main`.
   `mainPC()` là một hàm phụ assembly một dòng (`la a0, main; ret`) cho ra địa chỉ
   mã của `main`, vốn khó lấy trực tiếp trong Go.
3. **satp = 0.** Phân trang vẫn tắt cho tới khi Chương 5 dựng một bảng trang.
4. **Ủy quyền trap.** Mặc định mọi trap đi về M-mode. Ta ủy quyền ngoại lệ
   (`medeleg`) và ngắt (`mideleg`) về S-mode để kernel xử lý trực tiếp, và bật các
   nguồn ngắt supervisor trong `sie`.
5. **PMP.** Physical Memory Protection mặc định *từ chối* S-mode truy cập bộ nhớ
   vật lý. Ta mở một vùng duy nhất phủ tất cả để kernel có thể chạy được.
6. **Timer.** Thiết lập ngắt đồng hồ đầu tiên — nhịp tim mà bộ lập lịch về sau
   dùng để giành quyền các tiến trình (Chương 10).
7. **tp = hartid.** Id của hart chỉ đọc được ở M-mode (`mhartid`). Ta sao nó vào
   thanh ghi `tp` để mã S-mode hỏi "ta là CPU nào?" một cách rẻ tiền. Đây chính là
   thứ `cpuid()` trả về.
8. **mret.** Cú hạ xuống. Nhớ lại Chương 1 (§1.5): không có lệnh nào để *vào* một
   mức đặc quyền thấp hơn, nên ta giả vờ một cú *trở về* từ một trap chưa từng xảy
   ra. Sau `mret`, CPU ở S-mode, đang thực thi `main`.

### Thiết lập timer

```go
// start.go — yêu cầu hart này phát ra ngắt định thời
func timerInit() {
	w_menvcfg(r_menvcfg() | (1 << 63)) // bật phần mở rộng Sstc (stimecmp)
	w_mcounteren(r_mcounteren() | 2)   // cho S-mode đọc CSR time
	w_stimecmp(r_time() + 1_000_000)   // hẹn nhịp đầu tiên
}
```

Với phần mở rộng **Sstc**, mã supervisor có thể nạp ngắt định thời kế tiếp bằng
cách ghi thẳng `stimecmp` — không cần trap về machine mỗi nhịp. Ta chỉ cần M-mode
ở đây để *bật* khả năng đó; từ Chương 10 trở đi, timer được xử lý hoàn toàn trong
S-mode.

---

## 2.6 `main()`: hello từ chế độ supervisor

Sau `mret`, mọi hart bắt đầu thực thi `main` ở chế độ supervisor, mỗi hart trên
stack của riêng nó. Lúc này `main` làm việc nhỏ nhất có thể — in một dòng — để ta
có thể *thấy* rằng cả con đường boot hoạt động:

```go
// main.go
package kernel

//go:export main
func main() {
	if cpuid() == 0 {
		uartInitBare()
		print("\n")
		print("kernel xv6-go đang khởi động\n")
		print("\n")
	}
	// Mọi hart đều dừng ở đây. Hiện chưa có gì để làm thêm.
	for {
	}
}

// cpuid trả về id của hart hiện tại, do start() cất trong tp.
func cpuid() int {
	return int(r_tp())
}
```

Chỉ hart 0 in, nên lời chào xuất hiện một lần thay vì `NCPU` lần. Các hart khác
rơi thẳng vào vòng lặp nhàn rỗi. (Ở Chương 9 ta sẽ đưa các hart khác lên đúng
cách; ở Chương 10 tất cả sẽ vào bộ lập lịch.)

---

## 2.7 Chỉ vừa đủ UART để in

Trình điều khiển console đầy đủ là Chương 3. Ở đây ta cần phần tối thiểu: đẩy một
byte ra UART. Trên máy `virt`, UART 16550 nằm tại `0x10000000` (Chương 1, §1.8).
Gửi một byte là hai lần truy cập bộ nhớ — chờ tới khi thanh ghi giữ phát rỗng, rồi
ghi byte:

```go
// uart.go — xuất kiểu polling tối giản; trình điều khiển thật tới ở Chương 3
package kernel

import "unsafe"

const uart0 = 0x10000000

// Các offset thanh ghi 16550 ta cần ở đây.
const (
	uartTHR = 0      // thanh ghi giữ phát (ghi một byte vào để gửi)
	uartLSR = 5      // thanh ghi trạng thái dòng (line status)
	lsrTHRE = 1 << 5 // THR rỗng: được phép gửi byte kế tiếp
)

func uartReg(off uintptr) *uint8 {
	return (*uint8)(unsafe.Pointer(uintptr(uart0) + off))
}

func uartInitBare() {} // không cần cấu hình gì cho xuất kiểu polling dưới QEMU

func uartPutc(c byte) {
	for *uartReg(uartLSR)&lsrTHRE == 0 { // quay tại chỗ tới khi UART nhận được byte
	}
	*uartReg(uartTHR) = c
}

// print ghi một chuỗi ra UART, từng byte một.
func print(s string) {
	for i := 0; i < len(s); i++ {
		uartPutc(s[i])
	}
}
```

Cả "trình điều khiển thiết bị" gói gọn trong `uartPutc`: đọc thanh ghi trạng thái
dòng tại `0x10000005`, quay vòng chờ bit "phát rỗng", rồi ghi một byte vào
`0x10000000`. Đây là ý tưởng I/O-ánh-xạ-bộ-nhớ ở Chương 1 được cụ thể hóa —
**không có lệnh I/O đặc biệt nào; một thiết bị chỉ là bộ nhớ tại một địa chỉ đã
biết.** Phép ép kiểu `unsafe.Pointer` chính là kỹ thuật "khung nhìn có kiểu trên
một địa chỉ vật lý" mà ta sẽ dựa vào cho bảng trang và trapframe về sau.

---

## 2.8 Build và chạy

Một `Makefile` nhỏ ghép các mảnh lại:

```make
kernel.elf: *.go *.s kernel.ld riscv-virt.json
	tinygo build -target=riscv-virt.json -o kernel.elf .

qemu: kernel.elf
	qemu-system-riscv64 -machine virt -bios none -m 128M -smp 3 \
		-nographic -kernel kernel.elf
```

- `-bios none` bảo QEMU đừng nạp firmware mặc định; kernel của ta *là* thứ đầu
  tiên chạy.
- `-smp 3` cho ta ba hart, để có thể xác nhận chỉ hart 0 in.
- `-nographic` định tuyến UART ra terminal của bạn — không bao giờ cần GUI
  (Chương 0).

Chạy nó:

```console
$ make qemu

kernel xv6-go đang khởi động

```

Dòng-trống/lời-chào/dòng-trống đó là đầu ra của `main`. Để thoát QEMU, nhấn
`Ctrl-A` rồi `x`.

Nếu bạn thấy lời chào, xin chúc mừng: bạn đã viết mã chạy **trên máy trần**, tự
tay dựng một stack, cấu hình các CSR mức-machine, hạ xuống chế độ supervisor qua
`mret`, và điều khiển một thiết bị phần cứng — tất cả bằng Go, không hệ điều hành
nào bên dưới.

---

## 2.9 Những chỗ ta lướt qua (và nơi xử lý chúng)

- **Các hart khác** quay trong vòng lặp nhàn rỗi của `main`. Việc đưa đa lõi lên
  đúng cách, gồm cả đồng bộ để hart 0 hoàn tất khởi tạo trước, là Chương 9.
- **`print` không an toàn khi gọi từ hai hart cùng lúc** — các byte sẽ đan xen.
  Ở đây ta chỉ in từ hart 0; khóa console là Chương 3, còn bản thân khóa là
  Chương 9.
- **Phân trang đang tắt.** Địa chỉ vẫn là vật lý. Chương 5 dựng bảng trang kernel
  và bật phân trang.
- **Chưa có bộ cấp phát.** Mọi thứ ở đây dùng bộ nhớ cố định, dành sẵn tĩnh
  (`stack0`). Cấp phát động bắt đầu ở Chương 4.

---

## 2.10 Điều bạn nên mang theo

- QEMU thả mọi hart tại `0x80000000` ở chế độ machine mà không có stack; linker
  script bảo đảm `_entry` của ta nằm đúng ở đó.
- Việc bất khả lược bỏ của assembly là **dựng một stack** trước khi bất kỳ mã Go
  nào chạy được.
- Một kernel không thể dùng runtime Go chuẩn; **TinyGo với `gc: none` và
  `scheduler: none`** cho ta Go freestanding.
- `start` chỉ làm những gì *bắt buộc* phải làm ở chế độ machine, rồi hạ xuống chế
  độ supervisor bằng cách giả vờ một cú trở về trap với **`mret`**.
- **I/O ánh xạ bộ nhớ** nghĩa là một trình điều khiển thiết bị có thể nhỏ tới mức
  "quay vòng trên một bit trạng thái, rồi ghi một byte."

---

## Bài tập

1. **Số học stack.** Với `STACKSIZE = 4096`, `sp` mang giá trị gì khi vào `start`
   đối với hart 0? Đối với hart 2? Vì sao `_entry` cộng `(hartid+1)*STACKSIZE` chứ
   không phải `hartid*STACKSIZE`?

2. **Bỏ một bước.** Dự đoán điều gì xảy ra nếu bạn chú thích (comment) bỏ phần
   thiết lập PMP (bước 5) trong `start`. Rồi thử xem. Vì sao kernel hỏng *trước
   khi* in được bất cứ gì? (Gợi ý: §2.5, bước 5.)

3. **Đếm các hart.** Sửa `main` để *mọi* hart in `hart N dang boot` kèm id của
   nó. Chạy với `-smp 4`. Vì sao các dòng có thể ra đan xen hay bị rối, và chương
   nào về sau sửa điều đó?

4. **Mẹo mret.** Đặt `mstatus.MPP` thành chế độ *User* thay vì Supervisor trước
   `mret` và dự đoán điều gì xảy ra khi `main` thử lần ghi UART đầu tiên. Liên hệ
   câu trả lời với ba nhiệm vụ của hệ điều hành ở Chương 1 (§1.1).

5. **Byte trên đường truyền.** Sửa `uartPutc` để *không* chờ `lsrTHRE` (bỏ vòng
   lặp quay). Lời chào còn xuất hiện dưới QEMU không? Bạn có tin tưởng cách này
   trên phần cứng thật không? Giải thích vòng lặp quay bảo vệ chống lại điều gì.

---

*Tiếp theo: **Chương 3 — Giao tiếp với phần cứng: Console**, nơi ta biến đoạn
UART hai dòng này thành một trình điều khiển thật, điều khiển bằng ngắt, có nhập,
có đệm xuất, và một `printk` đàng hoàng — tiếng nói của kernel trong suốt phần còn
lại của cuốn sách.*
