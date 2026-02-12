FROM node:20-alpine

WORKDIR /app

# Install dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Prune devDependencies (optional but good for image size)
# RUN npm prune --production

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
