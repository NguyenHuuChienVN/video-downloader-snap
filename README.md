# Video Downloader (không logo) – TikTok / Instagram / Facebook / X

## Yêu cầu
- Node.js >= 18
- yt-dlp (https://github.com/yt-dlp/yt-dlp/releases) có trong PATH, hoặc đặt biến `YTDLP_PATH`

## Cài đặt & chạy local
    pip install -U yt-dlp        # hoặc tải binary, hoặc: brew install yt-dlp
    npm install
    npm start                    # mở http://localhost:3000

Biến môi trường: PORT (3000), YTDLP_PATH, MAX_JOBS (4 – số lượt tải đồng thời).

## Deploy bằng Docker (khuyên dùng)
    docker build -t vd .
    docker run -d --restart=always -p 80:3000 --name vd vd

Render / Railway / Fly.io: tạo Web Service từ repo có Dockerfile này, cổng 3000, health check /healthz.
KHÔNG dùng Vercel/Netlify (cần chạy tiến trình yt-dlp và stream file lớn).

## Deploy VPS Ubuntu (không Docker)
    sudo apt install -y nodejs npm nginx python3-pip
    sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
    npm install --omit=dev && sudo npm i -g pm2 && pm2 start server.js --name vd && pm2 save && pm2 startup
Nginx: proxy_pass http://127.0.0.1:3000; thêm `proxy_buffering off;` và `proxy_read_timeout 300s;`, rồi chạy `certbot --nginx` để lấy HTTPS.

## Bảo trì
TikTok/Instagram hay đổi API → khi lỗi hãy cập nhật yt-dlp (`yt-dlp -U` hoặc build lại Docker image). Instagram bài riêng tư cần cookie (không hỗ trợ sẵn).
