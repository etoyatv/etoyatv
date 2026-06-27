FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
