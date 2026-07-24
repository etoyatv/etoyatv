FROM node:18

RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /worker

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
