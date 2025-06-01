export default function getLanguageConfig(language: string) {
  const config: Record<
    string,
    { image: string; port: number; envVars?: string[] }
  > = {
    node: { image: "node:18", port: 8080, envVars: ["NODE_ENV=development"] },
    javascript: {
      image: "node:18",
      port: 8080,
      envVars: ["NODE_ENV=development"],
    },
    python: {
      image: "python:3.10",
      port: 5000,
      envVars: ["FLASK_ENV=development"],
    },
    cpp: {image:"gcc:13",port:8080 },
    java: { image: "openjdk:17", port: 8080, envVars: ["JAVA_OPTS=-Xmx512m"] },
    golang: { image: "golang:1.19", port: 8080, envVars: [] },
    rust: { image: "rust:latest", port: 8080, envVars: [] },
    reactjs: {
      image: "node:18",
      port: 5173,
      envVars: ["HOST=0.0.0.0", "PORT=5173"],
    },
  };
  return config[language.toLowerCase()] || null;
}
