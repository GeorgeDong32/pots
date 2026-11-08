import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The pi-durable import boundary (M3 seam): only src/substrate.ts and
 * src/durable-ext/** may import @earendil-works/pi-durable. Upgrading the
 * pin therefore has an enumerable blast radius (P3-4.3).
 */
const durableRestriction = {
	"no-restricted-imports": [
		"error",
		{
			patterns: [
				{
					group: ["@earendil-works/pi-durable", "@earendil-works/pi-durable/*"],
					message:
						"pi-durable must be imported only from src/substrate.ts (or src/durable-ext/**). See DEVIATIONS.md.",
				},
			],
		},
	],
};

export default tseslint.config(
	{ ignores: ["dist/**", "node_modules/**", "launchd/**"] },
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				console: "readonly",
				process: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				setInterval: "readonly",
				clearInterval: "readonly",
			},
		},
	},
	{
		files: ["src/**/*.ts", "test/**/*.ts"],
		languageOptions: {
			parserOptions: { ecmaVersion: 2023, sourceType: "module" },
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		files: ["src/**/*.ts"],
		rules: durableRestriction,
	},
	{
		// The seam itself (and future extension-authoring modules) may import pi-durable.
		files: ["src/substrate.ts", "src/durable-ext/**/*.ts"],
		rules: { "no-restricted-imports": "off" },
	},
);
