FROM node:18-alpine

# Install ffmpeg for HLS processing
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 1935 8000 8001
CMD ["npm", "start"]
