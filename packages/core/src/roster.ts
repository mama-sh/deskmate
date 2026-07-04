// The roster types core operates on. Core owns the TYPES; a consumer owns the
// DATA (a generated `deskmates.ts` / `deskmate.config.ts` registry). Every
// roster-aware helper in core takes a `Roster` as a parameter so the engine
// never imports a consumer-generated file.

export type DeskmateIdentity = {
  id: string;
  displayName: string;
  emoji: string;
  summary: string;
  providers: string[];
};

export type Roster = Record<string, DeskmateIdentity>;
