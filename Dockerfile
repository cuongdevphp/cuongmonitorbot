# Image chạy bot trên Northflank (hoặc bất kỳ nơi nào chạy container).
FROM node:24-slim

ENV NODE_ENV=production
# Ghim cổng để khớp EXPOSE bên dưới và cổng công khai khai báo trên Northflank
ENV PORT=3000

WORKDIR /app
# App ghi file cache excluded-symbols.json cạnh index.js nên thư mục phải ghi được bởi user node
RUN chown node:node /app
USER node

# Cài thư viện trước để Docker cache lớp này khi chỉ sửa code
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node index.js ./
COPY --chown=node:node public ./public

# Cổng mặc định của app (index.js dùng process.env.PORT, không có thì 3000)
EXPOSE 3000

# Gọi node trực tiếp thay vì npm start để tín hiệu dừng container tới thẳng tiến trình.
# Cờ --use-system-ca trong npm start chỉ cần trên máy có proxy công ty.
CMD ["node", "index.js"]
