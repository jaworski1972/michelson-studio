/** @type {import('next').NextConfig} */
const nextConfig = {
  // pliki silnika są wysyłane do maszyny obróbki przy każdym zleceniu
  outputFileTracingIncludes: {
    "/api/jobs": ["./engine/**/*"],
  },
};
export default nextConfig;
