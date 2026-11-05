export const readStringField = (
  source: object,
  key: string,
): string | undefined => {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : undefined;
};
