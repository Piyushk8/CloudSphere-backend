export default function getLanguageConfig(language: string) {
  const config: Record<
    string,
    {
      image: string;
      port: number;
      envVars?: string[];
      zipKey: string;
      installCommand?: string;
    }
  > = {
    node: {
      image: "node:18",
      port: 8080,
      envVars: ["NODE_ENV=development"],
      zipKey: "nodejs",
      installCommand: `
          apt update && apt install -y unzip && \
          chmod +x /runner.sh && \
          cd /workspace && unzip base.zip -d . && rm base.zip && \
          npm install && npm i nodemon
        `,
    },
    nodejs: {
      image: "node:18",
      port: 8080,
      envVars: ["NODE_ENV=development"],
      zipKey: "nodejs",
      installCommand: `
          apt update && apt install -y unzip && \
          chmod +x /runner.sh && \
          cd /workspace && unzip base.zip -d . && rm base.zip && \
          npm install && npm i nodemon
        `,
    },
    expressjs: {
      image: "node:18",
      port: 8080,
      zipKey: "expressjs.zip",
      installCommand: `
          apt update && apt install -y unzip && \
          chmod +x /runner.sh && \
          cd /workspace && unzip base.zip -d . && rm base.zip && \
          npm install && npm i nodemom
        `,
      envVars: ["NODE_ENV=development"],
    },
    python: {
      zipKey: "python",
      installCommand: `
          apt update && apt install -y unzip && \
          cd /workspace \
          `,
      image: "python:3.10",
      port: 5000,
      envVars: ["FLASK_ENV=development"],
    },
    cpp: { image: "gcc:13", port: 8080, zipKey: "cpp" },
    java: {
      image: "openjdk:17",
      port: 8080,
      envVars: ["JAVA_OPTS=-Xmx512m"],
      zipKey: "java",
    },
    go: { image: "golang:1.19", port: 8080, envVars: [], zipKey: "go" },
    reactjs: {
      image: "node:18",
      port: 5173,
      zipKey: "reactjs.zip",
      installCommand: `
          apt update && apt install -y unzip && \
          chmod +x /runner.sh && \
          cd /workspace && unzip base.zip -d . && rm base.zip && \
          npm install
        `,
      envVars: ["HOST=0.0.0.0", "PORT=5173"],
    },
    nextjs: {
      image: "node:18",
      port: 3000,
      zipKey: "nextjs.zip",
      installCommand: `
          apt update && apt install -y unzip && \
          chmod +x /runner.sh && \
          cd /workspace && unzip base.zip -d . && rm base.zip && \
          npm install 
        `,
      envVars: ["HOST=0.0.0.0"],
    },
  };
  return config[language.toLowerCase()] || null;
}