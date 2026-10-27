/** Presentation spelling for the existing demo resident; identity stays unchanged. */
export function residentDisplayName(id: string, name: string): string {
  return id === "resident_003" && name === "Margaret Chen" ? "Margaret Chan" : name;
}
