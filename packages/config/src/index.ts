/** Feature flags. Experimental features must not contaminate stable routing. */
export const flags = {
  mountainAliasShim: false,
  experimentalDungeons: false,
} as const;
