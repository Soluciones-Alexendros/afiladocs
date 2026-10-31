# Seguridad — afiladocs

### Propósito de este documento

- **Objetivos:** Canal privado de vulnerabilidades, ventanas de respuesta y
  versiones soportadas. Sin issues públicos explotables.
- **Estructura:** Reportar → Ventanas → Versiones → Alcance.
- **Contenido a integrar según contexto:** Correo `ops@afiladocs.com` y
  perímetro del SaaS. Rotación operativa:
  [docs/runbooks/rotacion-secretos.md](docs/runbooks/rotacion-secretos.md).

## Reportar vulnerabilidades

Si descubres una vulnerabilidad, **no abras un issue público** con detalles
explotables.

1. Escribe a **ops@afiladocs.com** con descripción, impacto, reproducción y
   commit/versión, o
2. Usa [GitHub Security Advisories](https://github.com/Soluciones-Alexendros/saas-afiladocs/security/advisories/new)
   (privado) si tienes acceso.

## Ventanas de respuesta

| Paso                                | Objetivo                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Acuse de recibo                     | ≤ 48 horas laborables (Europe/Madrid)                                         |
| Evaluación inicial                  | ≤ 5 días laborables                                                           |
| Coordinación de parche / disclosure | Según severidad; no publicar detalles explotables hasta que exista mitigación |

## Versiones soportadas

| Canal                                  | Soporte                          |
| -------------------------------------- | -------------------------------- |
| Rama `main` (producción afiladocs.com) | Sí — recibe parches de seguridad |
| Previews / ramas de feature            | No — solo para validación        |
| Forks desactualizados                  | No — alinea con `main`           |

## Alcance

Aplicación web afiladocs.com (checkout Stripe, portal, ops, webhooks, crons).
Infraestructura de terceros (Stripe, Supabase, DocuSeal, Vercel) debe
reportarse también a sus programas respectivos cuando el fallo sea suyo.

Bot de dependencias: **Renovate** (no `dependabot.yml` de version-updates).
Dependabot Alerts ON. Secret scanning + push protection: prerrequisito de org.
