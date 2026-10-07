import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static checks on supabase/migrations/0001_init.sql. They cannot run the SQL (that needs a Postgres), so they pin down
 * the text of the guard that matters: the limits on increment_ai_usage. The behaviour was checked against PostgreSQL 16
 * by calling the function as the "authenticated" role: months outside the window were refused and a loop over 24,000
 * months left three rows in ai_usage instead of 24,000.
 */
const sql = readFileSync(path.resolve(import.meta.dirname, "../../supabase/migrations/0001_init.sql"), "utf8");

function functionBody(name: string): string {
  const start = sql.indexOf(`create function public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = sql.indexOf("as $$", start);
  const close = sql.indexOf("$$;", open + 5);
  return sql.slice(open + 5, close);
}

describe("increment_ai_usage", () => {
  const body = functionBody("increment_ai_usage");

  it("only counts the current UK month and the one either side of it", () => {
    expect(body).toMatch(/'Europe\/London'/);
    const check = /if p_month not in \(([\s\S]*?)\) then/.exec(body);
    expect(check, "a check of p_month against the allowed months").not.toBeNull();
    const allowed = check?.[1] ?? "";
    expect(allowed).toMatch(/pg_catalog\.to_char\(v_this - interval '1 month', 'YYYY-MM'\)/);
    expect(allowed).toMatch(/pg_catalog\.to_char\(v_this, 'YYYY-MM'\)/);
    expect(allowed).toMatch(/pg_catalog\.to_char\(v_this \+ interval '1 month', 'YYYY-MM'\)/);
  });

  it("works the current month out from the database clock, not from anything the caller sends", () => {
    expect(body).toMatch(/v_this timestamp := pg_catalog\.date_trunc\('month', pg_catalog\.now\(\) at time zone 'Europe\/London'\)/);
  });

  it("refuses a month outside the window before it can write a row", () => {
    const refusal = body.indexOf("The month is outside the range that can be counted.");
    const insert = body.indexOf("insert into public.ai_usage");
    const format = body.indexOf("The month must be written as YYYY-MM.");
    expect(refusal).toBeGreaterThan(-1);
    expect(format).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(format).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(insert);
    expect(body).toMatch(/The month is outside the range that can be counted\.' using errcode = '22023'/);
  });

  it("still takes the user from auth.uid(), refuses a caller who is not signed in, and counts only under the cap", () => {
    expect(body).toMatch(/v_user uuid := auth\.uid\(\)/);
    expect(body).toMatch(/errcode = '28000'/);
    expect(body).toMatch(/where u\.calls < p_cap/);
    expect(sql).toMatch(/create function public\.increment_ai_usage\(p_month text, p_cap integer\)[\s\S]*?security definer\s+set search_path = ''/);
  });

  it("is documented where it is defined", () => {
    expect(sql).toMatch(/p_month must be the current UK month or the one before or after it/);
  });
});
