FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
EXPOSE 3003
ENV NODE_ENV=production
CMD ["bun", "run", "src/main.ts"]
