# AGENTS.md

### Propósito de este documento

- **Objetivos:** Fijar el contrato operativo para agentes de código y el rol
  Mantenedor: fuentes de verdad, autonomía, comandos y Definition of Done.
- **Estructura:** Destinatarios → fuentes de verdad → unidad de trabajo →
  autonomía → stack y comandos → convenciones → layout → Definition of Done.
- **Contenido a integrar según contexto:** Adapta layout, scripts pnpm y
  umbrales de cobertura de este SaaS. No copies un `AGENTS.md` de sitio
  estático ni de una CLI. No reescribas checkout, webhooks ni RLS sin ADR.
  No toques `SUPPORT.md` ni los runbooks vivos salvo para enlazarlos.

**Destinatarios:** agentes de código y el rol Mantenedor que trabajen en este
repositorio.  
**Propósito:** contrato operativo. Homogeneizamos **nombres y contratos**, no
el lenguaje ni la UI del producto.

## Fuentes de verdad (orden)

1. [README.md](./README.md) — qué es Afiladocs y cómo arrancarlo
2. Este archivo
3. [ARCHITECTURE.md](./ARCHITECTURE.md)
4. [docs/architecture/decisions/](./docs/architecture/decisions/) — ADRs; el
   stub [`DECISIONS.md`](./DECISIONS.md) apunta aquí
5. [CONTRIBUTING.md](./CONTRIBUTING.md)
6. [SECURITY.md](./SECURITY.md)
7. [SUPPORT.md](./SUPPORT.md) y [docs/runbooks/](./docs/runbooks/) — incidentes
8. [CLAUDE.md](./CLAUDE.md) — reglas absolutas del stack (secretos, Zod, RGPD)

No reinventes requisitos. Si falta ancla, paras y preguntas.

## Hechos de producto

- SaaS B2C de plantillas legales rellenables (Valencia): Next.js App Router,
  TypeScript strict, Tailwind v4, Prisma 7, Stripe, Supabase, DocuSeal,
  Verifactu, Resend.
- Catálogo en tabla Prisma `products` (no en whitelist de env vars).
- Checkout Stripe → Verifactu → DocuSeal → descarga firmada en `/portal`.
- Deploy en Vercel (`cdg1`). Supabase canónico = Vercel Marketplace Free.
- DocuSeal es el único firmante. No reintroducir Documenso.

## Unidad de trabajo

```
Objetivo: <resultado verificable>
Traza: <ADR / issue / ruta>
Alcance: <archivos>
Exclusiones: <qué no harás>
Pruebas: pnpm test / pnpm run smoke / pnpm run test:e2e
Criterio de cierre: CI quality + test + build + smoke verdes
```

Una sesión = una unidad cohesiva. PR pequeño. Mensajes al humano y commits en
español (Conventional Commits). Al abrir PRs desde el flujo de commit,
crearlos como **draft**.

## Autonomía

**Puedes sin preguntar**

- Tests que fijan comportamiento ya aceptado
- Corregir lint/typecheck causados por tu cambio
- Docs de guía/runbook en español
- Refactors locales que no cambien rutas públicas ni el contrato de pago/firma

**Requiere confirmación**

- Cambiar `delivery_mode`, webhooks, RLS o CSP → ADR previo
- Dependencia runtime nueva
- Tocar `STRIPE_*`, `DOCUSEAL_*`, `CRON_SECRET` o secretos `NEXT_PUBLIC_*`
- Reescribir `SUPPORT.md` o un runbook vivo sin necesidad operativa

## Stack y comandos

- Node 22 (`.nvmrc`), pnpm (`packageManager`), TypeScript strict, Next.js,
  Vitest, Playwright
- Coverage documentado ≥ 70 % statements en `src/lib/stripe/`,
  `src/lib/orders/`, `src/lib/verifactu/`, `src/app/api/**` — mínimo de flota
  ≥ 70 %; no se baja el gate

```bash
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run check:env
pnpm run test:coverage
pnpm run build && pnpm run smoke
make validate
```

CI principal (`.github/workflows/ci.yml`): jobs `quality`, `test`, `build`,
`smoke`. El job de producto `security` (actionlint + zizmor) no se renombra.
`post-merge.yml` se conserva aparte.

## Convenciones

- Ramas `feat/` `fix/` `docs/` `chore/` (los agentes Cloud usan `cursor/…`)
- Hook husky: lint-staged (prettier + eslint) en pre-commit; Conventional
  Commits
- Idioma: README/CONTRIBUTING/docs de guía y runbooks en español
- No commitees `.next/`, `coverage/`, `.env.local` ni secretos
- Nunca `any` ni `@ts-ignore` sin justificación + issue

## Layout

```
src/app/        App Router: (marketing), portal, ops, api
src/lib/        env, auth, catalog, orders, signing, stripe, verifactu
src/components/ UI marketing / portal / ops / shadcn
src/emails/     plantillas React Email
prisma/         schema + migraciones
docs/           architecture/, guides/, guias/, runbooks/
```

## Definition of Done

- Criterios de la traza cumplidos
- Check único `ci-gate` verde (agrega `quality`, `test`, `build`, `smoke`,
  `security`, `secrets` y `sca`)
- Docs canónicos actualizados si cambia el contrato
- Sin secretos en el diff
