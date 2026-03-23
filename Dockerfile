FROM node:20-alpine

# Directorio de trabajo en el contenedor
WORKDIR /usr/src/app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias
RUN npm ci --only=production

# Copiar el código fuente (excluyendo lo que está en .dockerignore)
COPY . .

# Exponer el puerto configurado (el bot por defecto usa 8080 en bot.js)
EXPOSE 8080

# Iniciar la aplicación
CMD ["npm", "start"]
