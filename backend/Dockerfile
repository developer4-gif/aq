FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 4000
# tsx watch = run TypeScript directly + restart on file change
CMD ["npx", "tsx", "watch", "src/index.ts"]
