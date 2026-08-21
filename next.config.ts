import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/",
      headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
    }];
  },
  webpack(config, { webpack }) {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^cloudflare:workers$/,
        path.resolve(process.cwd(), "lib/cloudflare-workers-stub.ts"),
      ),
    );
    return config;
  },
};

export default nextConfig;
