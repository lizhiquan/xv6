# Chương 0 — Cài đặt bộ công cụ

> Trước khi viết bất kỳ dòng mã kernel nào, hãy dựng một môi trường phát triển có
> thể assemble, link và **chạy một kernel RISC-V dưới QEMU** — rồi kiểm chứng mọi
> công cụ đều hoạt động. Nửa giờ ở đây sẽ tiết kiệm rất nhiều rối rắm ở Chương 2,
> khi việc đầu tiên ta làm là khởi động một ảnh (image) thật.

Bạn chưa chạy chính kernel xv6 vội — chưa có gì để chạy cho tới Chương 2. Mục tiêu
của chương này hẹp hơn nhưng cũng quan trọng không kém: cài các công cụ, xác nhận
phiên bản của chúng, và hiểu mỗi thứ dùng để *làm gì*.

---

## 0.1 Bạn sẽ cần gì, và vì sao

Ta đang xây một kernel chạy trên máy ảo RISC-V `virt`, viết chủ yếu bằng Go. Điều
đó quyết định bốn phần mềm:

| Công cụ | Bắt buộc? | Nó làm gì cho ta |
|------|-----------|---------------------|
| **QEMU** (`qemu-system-riscv64`) | **Có** | Mô phỏng máy RISC-V `virt` mà ta khởi động trên đó. Đây *chính là* phần cứng của ta. |
| **Go** (1.22+) | **Có** | Ngôn ngữ viết kernel; cũng để chạy script build và công cụ trên máy chủ (host). |
| **TinyGo** (0.31+) | **Có** | Biên dịch Go cho một đích *freestanding* (không có hệ điều hành bên dưới). Nó đóng gói sẵn LLVM/clang/lld, nên cũng assemble được các tập tin `.s` và link ảnh kernel cuối cùng. Đây là cách ta thoát khỏi runtime chuẩn của Go (Chương 2). |
| **Bộ công cụ RISC-V GNU** (`riscv64-unknown-elf-*`) | Nên có | `gdb` để gỡ lỗi ở mức mã nguồn dưới QEMU, cùng `objdump`/`objcopy`/`readelf` để soi các ảnh kernel (Phụ lục C). |
| **make** + **git** | **Có** | Điều khiển quá trình build và checkout mã của từng chương. |

Ý tưởng then chốt, được mở rộng ở Chương 1 (§1.6) và Chương 2: một chương trình
Go bình thường mặc định có một hệ điều hành bên dưới nó. Kernel của ta *chính là*
cái bên dưới, nên ta không thể dùng đường `go build`/runtime chuẩn thông thường.
**TinyGo** cho ta một bản biên dịch freestanding — đó là lý do nó bắt buộc, chứ
không phải tùy chọn.

---

## 0.2 Cài đặt — macOS (Homebrew)

```sh
# QEMU + bộ công cụ RISC-V GNU (gdb, objdump, objcopy…)
brew tap riscv-software-src/riscv
brew install qemu riscv-gnu-toolchain

# Go và TinyGo
brew install go tinygo
```

Nếu `brew install riscv-gnu-toolchain` chậm (nó có thể build từ mã nguồn), bạn có
thể hoãn lại — nó chỉ cần cho việc gỡ lỗi, mà ta chưa tới đó đâu.

---

## 0.3 Cài đặt — Linux

**Debian / Ubuntu:**

```sh
sudo apt update
sudo apt install -y git build-essential qemu-system-misc \
                    gcc-riscv64-unknown-elf gdb-multiarch
# Go: cài bản tarball chính thức (gói của distro thường cũ)
#   https://go.dev/dl/  — rồi thêm /usr/local/go/bin vào PATH
# TinyGo: tải file .deb từ https://github.com/tinygo-org/tinygo/releases
```

**Fedora:**

```sh
sudo dnf install -y git make qemu-system-riscv \
                    binutils-riscv64-linux-gnu gdb
# Go và TinyGo như trên (tarball chính thức / bản release)
```

**Arch:**

```sh
sudo pacman -S --needed git make qemu-system-riscv riscv64-elf-gcc \
                        riscv64-elf-gdb go
# TinyGo: từ AUR (ví dụ `yay -S tinygo-bin`)
```

Trên Linux, `qemu-system-riscv64` nằm trong gói `qemu-system-misc` /
`qemu-system-riscv` tùy distro.

---

## 0.4 Ghi chú về Go so với TinyGo

Bạn sẽ cài **cả hai**, và chúng đóng vai trò khác nhau:

- **`go`** — cho các chương trình phụ trợ phía host (ví dụ một công cụ dựng ảnh hệ
  thống tập tin ban đầu) và để chạy kiểm thử trên máy phát triển của bạn.
- **`tinygo`** — để biên dịch kernel và các chương trình người dùng thành một ảnh
  RISC-V không có hệ điều hành bên dưới. TinyGo cho ta tắt bộ thu gom rác và
  scheduler, và xuất ra một nhị phân trần — điều mà bộ công cụ `go` chuẩn không làm
  gọn gàng được.

Ta cũng sẽ không dựa vào chính runtime của TinyGo — Chương 2 lược nó về mức tối
thiểu. Lúc này, chỉ cần chắc chắn cả hai lệnh đều tồn tại.

---

## 0.5 Lấy mã nguồn

Cuốn sách được viết để bạn xây kernel tăng dần; mỗi chương tương ứng với một commit
đã gắn tag mà bạn có thể checkout và chạy.

```sh
git clone https://github.com/lizhiquan/xv6.git
cd xv6
```

> Phần văn bản của sách nằm trong kho này dưới `en/` và `vi/`. Khi các chương bắt
> đầu có mã, mỗi chương sẽ chỉ cho bạn tag tương ứng (ví dụ `git checkout ch02`)
> để bạn đối chiếu phần mình làm với một mốc đã biết là chạy đúng. Nếu bạn muốn tự
> gõ tất cả — điều được khuyến khích để học — hãy khởi tạo một kho rỗng và làm theo;
> các tag ở đó như một lưới an toàn.

---

## 0.6 Kiểm tra nhanh (smoke test)

Xác nhận mọi công cụ đều nằm trong `PATH` và đủ mới:

```sh
qemu-system-riscv64 --version     # kỳ vọng 7.0 trở lên
go version                        # kỳ vọng go1.22 trở lên
tinygo version                    # kỳ vọng 0.31 trở lên
riscv64-unknown-elf-gdb --version # (tùy chọn) bản gần đây bất kỳ
make --version
git --version
```

Bạn cũng có thể xác nhận QEMU thực sự biết cỗ máy ta sẽ nhắm tới:

```sh
qemu-system-riscv64 -machine help | grep virt
```

Bạn sẽ thấy một dòng cho `virt` ("RISC-V VirtIO board"). Cỗ máy đó — với UART ở
`0x10000000`, đĩa virtio ở `0x10001000`, RAM ở `0x80000000` — chính là phần cứng
được mô tả ở Chương 1 (§1.8) và là đích đến của mọi cột mốc trong cuốn sách này.

Chưa có gì để khởi động vội: ảnh khởi động được đầu tiên xuất hiện ở cuối Chương 2.
Nếu tất cả các lệnh trên đều in ra phiên bản, môi trường của bạn đã sẵn sàng.

---

## 0.7 Thiết lập trình soạn thảo (tùy chọn nhưng nên có)

- **gopls** (Go language server) hoạt động tốt, nhưng hãy lưu ý rằng mã kernel
  freestanding dùng build tag và `unsafe` theo những cách mà trình soạn thảo có
  thể đánh dấu là bất thường. Đó là chuyện bình thường; mã vẫn biên dịch được dưới
  TinyGo.
- Một bộ tô màu cú pháp assembly RISC-V sẽ hữu ích cho các tập tin `.s`.
- Hãy mở sẵn một khung terminal cho `tinygo build` + `qemu-system-riscv64` — vòng
  lặp sửa/build/khởi động là nhịp tim của cuốn sách này.

---

## 0.8 Khắc phục sự cố

| Hiện tượng | Cách khắc phục khả dĩ |
|---------|-----------|
| `qemu-system-riscv64: command not found` | Tập tin nhị phân nằm trong `qemu-system-misc`/`qemu-system-riscv`; cài lại gói đó, hoặc kiểm tra `PATH`. |
| Cài xong vẫn `tinygo: command not found` | Thêm thư mục `bin` của TinyGo vào `PATH` (bản `.deb`/release cài vào `/usr/local/tinygo/bin`). |
| `riscv-gnu-toolchain` cài mãi không xong trên Homebrew | Nó đang build từ mã nguồn. Cứ để chạy nền, hoặc bỏ qua tới các chương gỡ lỗi. |
| Go cũ từ distro của bạn | Gỡ đi và cài bản tarball chính thức từ <https://go.dev/dl/>. |
| Lỗi cửa sổ/đồ họa của QEMU | Ta luôn chạy với `-nographic`; bạn không bao giờ cần giao diện đồ họa. |

---

## Danh sách kiểm tra

Trước khi đi tiếp, bạn nên đánh dấu được mọi ô:

- [ ] `qemu-system-riscv64 --version` in ra 7.0+
- [ ] `qemu-system-riscv64 -machine help` liệt kê `virt`
- [ ] `go version` in ra 1.22+
- [ ] `tinygo version` in ra 0.31+
- [ ] `make` và `git` đã sẵn sàng
- [ ] (tùy chọn) đã cài một bản `gdb` cho RISC-V để dùng về sau

---

*Tiếp theo: **Chương 1 — Hệ điều hành làm những gì**, tấm bản đồ khái niệm của
toàn hệ thống. Rồi **Chương 2** sẽ đưa bộ công cụ này vào việc và khởi động ảnh
đầu tiên của ta.*
