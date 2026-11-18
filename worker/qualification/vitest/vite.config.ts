import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const state = process.env.VITEST_QUALIFICATION_STATE;
export default defineConfig({ plugins: [cloudflare(state ? { persistState: { path: state } } : {})] });
