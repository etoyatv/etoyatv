FROM node:18-alpine

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm install

# Copy all the remaining files
COPY . .

# Expose port
EXPOSE 3002

# Command to run the application
CMD ["npm", "start"]
