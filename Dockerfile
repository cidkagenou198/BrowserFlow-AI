FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN mkdir -p logs screenshots user_data

EXPOSE 3000

ENV PORT=3000
ENV HEADLESS=true

CMD ["npm", "start"]
