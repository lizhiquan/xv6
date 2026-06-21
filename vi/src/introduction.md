# Xây dựng hệ điều hành bằng Go: xv6 trên RISC-V

> Một cuốn sách thực hành dạy các nguyên lý nền tảng của hệ điều hành bằng cách
> tự tay xây dựng một kernel kiểu Unix hoàn chỉnh — xv6 — bằng Go, trên kiến trúc
> RISC-V. Mỗi chương kết thúc bằng một cột mốc chạy được, khởi động được dưới
> QEMU.

---

## Về cuốn sách này

### Dành cho ai
Những lập trình viên đã quen với Go và muốn hiểu một hệ điều hành thực sự vận
hành như thế nào — khởi động, bộ nhớ ảo, trap, lập lịch, hệ thống tập tin — bằng
cách tự xây dựng một cái, thay vì chỉ đọc về nó.

### Chúng ta sẽ xây dựng gì
**xv6** là một hệ điều hành nhỏ kiểu Unix: một kernel khởi động trên phần cứng
thật (ở đây là máy ảo RISC-V `virt`), quản lý bộ nhớ và tiến trình, cung cấp một
hệ thống tập tin, và chạy một shell tương tác với những tiện ích quen thuộc —
`cat`, `ls`, `grep` và bè bạn. Nó đủ nhỏ để hiểu trọn vẹn, nhưng đủ đầy đủ để là
một hệ thống thực thụ. Xuyên suốt cuốn sách, bạn sẽ xây dựng toàn bộ nó, từ lệnh
đầu tiên mà CPU thực thi cho đến shell.

### Vì sao chọn Go
Go cho ta một hệ kiểu (type system) thực sự, slice và string, `defer`, xử lý lỗi
rõ ràng, và một bộ công cụ dễ chịu — mà không cần lằng nhằng quản lý bộ nhớ thủ
công và đống header thường khiến code mức thấp khó đọc. Nhưng một kernel lại phá
vỡ vài giả định mà *runtime* của Go thường dựa vào, và cuốn sách thẳng thắn về
sự căng thẳng đó từ đầu đến cuối:
- **Ban đầu, không có runtime.** Runtime chuẩn của Go mặc định có một hệ điều
  hành bên dưới nó — để xin bộ nhớ, luồng (thread) và tín hiệu (signal). Trong
  một kernel, *chúng ta chính là cái bên dưới đó*. Các chương đầu chạy trên một
  bộ công cụ freestanding/kiểu-TinyGo và tự cung cấp vài ký hiệu runtime cần
  thiết.
- **Bộ thu gom rác (GC) trong kernel.** Ta sẽ bàn khi nào GC được phép chạy, vì
  sao trình xử lý interrupt, bộ lập lịch và các đường DMA phải không cấp phát bộ nhớ,
  và làm sao "ghim" (pin) bộ nhớ.
- **`unsafe` và các pragma của trình biên dịch.** `unsafe.Pointer`,
  `//go:nosplit`, `//go:noescape` và `//go:linkname` là những thứ làm cho Go mức
  thấp khả thi; ta sẽ học các quy tắc dùng chúng an toàn.
- **Goroutine không phải là tiến trình của ta.** Ta cố tình tự xây dựng cơ chế
  chuyển ngữ cảnh thay vì dựa vào goroutine, và sẽ giải thích vì sao một bộ lập
  lịch kernel cần quyền kiểm soát đó.

### Cách đọc
Mỗi chương đều theo cùng một nhịp: khái niệm → thiết kế → cài đặt → chạy thử dưới
QEMU → bài tập. Mã nguồn được xây dựng tăng dần trong một kho git duy nhất; mỗi
chương là một tag mà bạn có thể checkout và chạy.

### Yêu cầu trước & bộ công cụ (Chương 0 hướng dẫn cài đặt)
Bộ công cụ RISC-V GNU, QEMU (`qemu-system-riscv64`), Go (đường build
freestanding / TinyGo), `make`, và một trình gỡ lỗi (`gdb`/`lldb` hỗ trợ
RISC-V).

---

## Phần I — Nền tảng

### Chương 1: Hệ điều hành làm những gì
- Ranh giới kernel/người dùng; đặc quyền, cô lập, ghép kênh, trừu tượng hóa.
- Một vòng tham quan sản phẩm hoàn chỉnh: ta sẽ xây được gì khi tới trang cuối.
- Bố cục kho mã nguồn kernel Go của ta.
- RISC-V trong ba mươi phút: các thanh ghi, ba mức đặc quyền (M/S/U), CSR, quy ước
  gọi hàm, cơ chế trap.

### Chương 2: Từ lúc bật nguồn đến `main`
- Máy `virt` của QEMU và bản đồ bộ nhớ của nó.
- Chế độ machine, ROM khởi động, và linker script đặt kernel vào đúng chỗ.
- Đoạn assembly đầu tiên và `start`: dựng stack, hạ từ chế độ machine xuống chế
  độ supervisor.
- **Vấn đề của Go, ngay từ đầu:** khởi động *không có* runtime của Go — tắt GC và
  bộ lập lịch goroutine, tự cung cấp các ký hiệu runtime.
- Cột mốc: in "hello" qua UART từ một kernel Go chạy trên QEMU trần.

### Chương 3: Giao tiếp với phần cứng — Console
- I/O ánh xạ bộ nhớ (memory-mapped I/O); thiết bị UART (16550).
- Một trình điều khiển UART bằng Go, truy cập kiểu `volatile` qua `unsafe`.
- Một `printk` tối giản: định dạng mà không dùng `fmt`, không cấp phát.
- Xem trước spinlock: vì sao ngay cả `printk` cũng cần khóa.
- Cột mốc: một console kiểu polling mà bạn có thể `printk` ra.

---

## Phần II — Bộ nhớ

### Chương 4: Cấp phát bộ nhớ vật lý
- Bộ cấp phát danh sách rỗi (free list): bộ nhớ vật lý là một danh sách liên kết
  các khung trang (page frame) còn trống.
- Thiết kế một bộ cấp phát trang bằng Go mà GC tuyệt đối không được đụng tới — đặt
  nó trên một vùng vật lý cố định, số học con trỏ `unsafe.Pointer`, căn lề.
- Cột mốc: `kalloc`/`kfree` với một bài kiểm tra làm cạn rồi phục hồi bộ nhớ.

### Chương 5: Bộ nhớ ảo và bảng trang
- Phân trang Sv39 của RISC-V: bảng trang ba cấp, PTE, các bit quyền.
- `walk`, `mappages`, và dựng bảng trang của kernel.
- Thiết kế Go: biểu diễn PTE và bảng trang như những "view" `unsafe` có kiểu
  trên các trang vật lý.
- Bật phân trang (`satp`, `sfence.vma`) — khoảnh khắc các địa chỉ thay đổi ý nghĩa
  ngay dưới chân bạn.
- Cột mốc: kernel chạy với phân trang bật; ánh xạ RAM, UART, PLIC và đĩa.

### Chương 6: Không gian địa chỉ riêng cho từng tiến trình
- Ánh xạ của người dùng và của kernel; trang trampoline và các trang canh (guard
  page).
- Tạo, mở rộng và sao chép không gian địa chỉ người dùng; sao chép dữ liệu an toàn
  qua ranh giới người dùng/kernel (`copyin`/`copyout`).
- Cột mốc: dựng và chuyển vào một không gian địa chỉ người dùng.

---

## Phần III — Tiến trình, Trap và Đồng thời

### Chương 7: Trap, interrupt và syscall
- Cơ chế trap của RISC-V: `stvec`, `scause`, `sepc`, `sscratch`.
- Đường trap của người dùng và của kernel; trang trampoline.
- Viết phần vào/ra trap bằng assembly và lưu/khôi phục trapframe.
- Bảng điều phối syscall và việc lấy đối số.
- Cột mốc: một chương trình người dùng thực hiện một syscall và return.

### Chương 8: Tiến trình đầu tiên và `exec`
- Nạp ELF; dựng chương trình người dùng đầu tiên (`initcode`).
- Tiến trình đầu tiên ra đời thế nào và `init` khởi động ra sao.
- Thiết kế Go: phân tích ELF mà không dùng thư viện chuẩn.
- Cột mốc: khởi động đến tận lúc chạy một tập tin thực thi người dùng.

### Chương 9: Khóa và đa lõi
- Vì sao cần khóa: tranh chấp (race), mô hình bộ nhớ, các phép nguyên tử và hàng
  rào (fence) của RISC-V.
- Spinlock và sleep lock.
- Mô hình bộ nhớ của Go so với điều một kernel cần; phép nguyên tử ở mức kernel;
  tắt interrupt (`push_off`/`pop_off`).
- Chạy trên nhiều hart; trạng thái riêng cho từng CPU.
- Cột mốc: khởi động SMP với tất cả CPU cùng vào bộ lập lịch.

### Chương 10: Lập lịch và chuyển ngữ cảnh
- Bảng tiến trình, các trạng thái của tiến trình.
- Chuyển ngữ cảnh bằng assembly: lưu và khôi phục các thanh ghi callee-saved — cơ
  chế chuyển của *ta*, *không* phải goroutine, và vì sao lựa chọn đó là cố ý.
- Vòng lặp lập lịch, `yield`, và timer interrupt.
- `sleep`/`wakeup`: mẫu hình biến điều kiện (condition variable) nằm ở trái tim
  của kernel.
- Cột mốc: đa nhiệm preemptive qua các tiến trình và CPU.

### Chương 11: `fork`, `wait`, `exit` và `kill`
- Vòng đời tiến trình và quan hệ cha/con.
- Sao chép không gian địa chỉ, thu hồi tiến trình "zombie", chuyển nhận con mồ côi
  cho `init`.
- Cột mốc: `fork`/`exec`/`wait` chạy trọn vẹn từ đầu đến cuối.

---

## Phần IV — Hệ thống tập tin

### Chương 12: Trình điều khiển đĩa
- Thiết bị khối virtio: virtqueue, descriptor, giao thức thông báo.
- DMA trong một ngôn ngữ có thu gom rác: giữ cho vùng đệm ổn định về mặt vật lý.
- Cột mốc: đọc và ghi các khối đĩa thô.

### Chương 13: Bộ đệm khối (buffer cache)
- Bộ nhớ đệm cho các khối, danh sách LRU, `bread`/`bwrite`/`brelse`.
- Đồng thời: sleep lock cho từng vùng đệm.
- Cột mốc: một bộ đệm khối hoạt động trên trình điều khiển đĩa.

### Chương 14: Khôi phục sau sự cố — Tầng ghi nhật ký
- Vì sao cần ghi nhật ký trước-khi-ghi (write-ahead logging); mô hình giao dịch.
- `begin_op`/`end_op`, commit, và khôi phục khi khởi động.
- Cột mốc: sống sót qua một sự cố mô phỏng giữa lúc đang ghi.

### Chương 15: Inode và bố cục trên đĩa
- Superblock, bitmap khối, inode, các khối trực tiếp và gián tiếp.
- Cấp phát inode, ánh xạ offset của tập tin sang khối, đọc và ghi dữ liệu tập tin.
- Cột mốc: cấp phát và đọc/ghi dữ liệu tập tin qua inode.

### Chương 16: Thư mục và đường dẫn
- Mục thư mục (directory entry), tra cứu, và phân giải đường dẫn (`namei`).
- `link`, `unlink`, và các quy tắc đếm tham chiếu.
- Cột mốc: tạo, tra cứu và xóa tập tin theo đường dẫn.

### Chương 17: Tầng file descriptor
- Bảng tập tin đang mở, `dup`, và offset của tập tin.
- Đấu nối `open`, `read`, `write`, `close`.
- Pipe và tập tin thiết bị; console như một tập tin.
- Cột mốc: chuyển hướng (redirect) và pipe hoạt động từ phía kernel.

---

## Phần V — Không gian người dùng

### Chương 18: Thư viện người dùng
- Runtime phía người dùng: các stub syscall sinh tự động và phần bọc Go
  của chúng.
- Một thư viện chuẩn nhỏ — xuất định dạng, `malloc` — và câu chuyện runtime Go ở
  chế độ người dùng.
- Cột mốc: một chương trình người dùng liên kết với thư viện người dùng của ta.

### Chương 19: Shell
- Phân tích cú pháp, `fork`/`exec`, chuyển hướng, và đường ống (pipeline).
- Xây một shell chạy trên kernel của ta.
- Cột mốc: một shell tương tác.

### Chương 20: Các tiện ích userland
- Dựng những tiện ích kinh điển: `cat`, `echo`, `grep`, `ls`, `mkdir`, `rm`,
  `wc`, `ln`, `kill` và `init`.
- Cột mốc: một hệ thống một-người-dùng dùng được.

### Chương 21: Kiểm thử toàn bộ
- Một bộ kiểm thử áp lực cho tính đồng thời, hệ thống tập tin và khôi phục sự cố.
- Cột mốc: bộ kiểm thử vượt qua.

---

## Phần VI — Vượt ra ngoài kernel

### Chương 22: Suy ngẫm về Go trong kernel
- Nhìn lại: GC, bề mặt `unsafe`, kích thước nhị phân, và những chỗ trừu tượng bị
  "rò rỉ".
- Cái gì hoạt động đẹp đẽ và cái gì ta đã phải vật lộn.

### Chương 23: Đi tiếp từ đây
- mmap và phân trang theo nhu cầu (demand paging); `fork` sao-chép-khi-ghi (COW).
- Một ngăn xếp mạng (network stack); thêm thiết bị.
- Liệu một runtime Go thực thụ — goroutine, channel — có thể sống *bên trong*
  kernel không?
- Các chỉ dẫn vào tài liệu hệ điều hành rộng hơn và các bài lab MIT 6.1810.

---

## Phụ lục

- **A. Tham khảo RISC-V** — các lệnh, CSR, và một bản tóm tắt đặc tả đặc quyền.
- **B. Bộ công cụ Go freestanding** — các cờ build, ghi chú TinyGo, linker script,
  và các pragma (`//go:nosplit`, `//go:noescape`, `//go:linkname`).
- **C. QEMU & gỡ lỗi** — cách chạy, các công thức `gdb`/`lldb`, và xem bảng trang
  cùng trapframe.
- **D. Bản đồ bộ nhớ** — bố cục bộ nhớ vật lý và ảo, giải thích từng hằng số.

---

## Thứ tự xây dựng đề xuất (xương sống phụ thuộc)

```
boot → console → kalloc → vm → trap/syscall → exec/init
     → locks → scheduler → fork/wait
     → disk → bio → log → inode → dir → file
     → ulib → sh → utils → tests
```

Kernel khởi tạo các hệ con của nó theo đúng thứ tự phụ thuộc lúc khởi động — bạn
không thể có bảng tiến trình trước khi cấp phát được bộ nhớ, cũng không cấp phát
được bộ nhớ trước khi có phân trang. Chính thứ tự khởi tạo đó *là* thứ tự của cuốn
sách này, nên mỗi chương mở khóa chương kế tiếp, và kernel khởi động được, chạy
được ở cuối mỗi chương.
