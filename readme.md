# Custom Directus Access

This repository provides a custom implementation to modify access to Directus via a specified path.

### Usage

To configure the base path for your Directus instance, simply add the following environment variable:

```
BASE_PATH=<your_custom_path>
```

Make sure to replace `<your_custom_path>` with the desired access path.

### Running with Docker Compose

To run this setup using Docker Compose, follow these steps:

1. **Clone the Repository:**

   ```bash
   git clone git@github.com:panji09/directus-path.git
   cd directus-path
   ```

2. **Create a `docker-compose.yml` File:**

   Here’s a quick start configuration based on the [official Directus quickstart](https://docs.directus.io/self-hosted/quickstart.html):

   ```yaml
   version: '3.8'  # Add this line to specify the Docker Compose version

   services:
     directus:
       build: .
       ports:
         - 8055:8055
       volumes:
         - ./database:/directus/database
         - ./uploads:/directus/uploads
         - ./extensions:/directus/extensions
       environment:
         SECRET: "replace-with-secure-random-value"
         ADMIN_EMAIL: "admin@example.com"
         ADMIN_PASSWORD: "d1r3ctu5"
         DB_CLIENT: "sqlite3"
         DB_FILENAME: "/directus/database/data.db"
         WEBSOCKETS_ENABLED: "true"
         BASE_PATH: "console"
   ```

3. **Run Docker Compose:**

   Execute the following commands to start your Directus instance:

   ```bash
   docker compose build
   docker compose up -d
   ```

4. **Access Directus:**

   Open your browser and navigate to `http://localhost:8055/<your_custom_path>` to access your Directus instance.

### Additional Notes

- Make sure Docker and Docker Compose are installed on your machine.
- You can customize the database configuration and other environment variables as needed.
