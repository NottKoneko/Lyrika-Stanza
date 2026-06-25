# syntax=docker/dockerfile:1
FROM node:22-alpine

# Set deployment environment variables
ENV NODE_ENV=production

# Establish secure internal directory structure
WORKDIR /usr/src/app

# Leverage caching for dependency layers
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application tracking loop engine code
COPY . .

# Adjust runtime permissions to avoid running as root
USER node

# Execute deployment loop
CMD [ "node", "index.js" ]