/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Camera and location are only needed by this app's own pages.
          { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
