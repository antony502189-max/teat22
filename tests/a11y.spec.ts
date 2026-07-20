import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const routes = [
  { name: "inicio", path: "/#/" },
  { name: "resultados", path: "/#/buscar?q=Tenerife&alquiler=long" },
  {
    name: "mapa",
    path: "/#/buscar?q=Tenerife&alquiler=long&vista=mapa",
  },
  { name: "detalle", path: "/#/habitacion/armeñime-luminosa-01" },
  { name: "acceso", path: "/#/acceso" },
  { name: "registro", path: "/#/registro" },
  { name: "recuperar", path: "/#/recuperar-contrasena" },
  { name: "restablecer", path: "/#/restablecer-contrasena?token=demo" },
  { name: "favoritos", path: "/#/favoritos" },
  { name: "ayuda", path: "/#/ayuda" },
  {
    name: "guardadas",
    path: "/#/busquedas-guardadas",
    session: "host-demo",
  },
  { name: "perfil", path: "/#/perfil", session: "host-demo" },
  { name: "mis anuncios", path: "/#/mis-anuncios", session: "host-demo" },
  { name: "publicar", path: "/#/publicar", session: "host-demo" },
  { name: "administración", path: "/#/admin", session: "admin-demo" },
];

const openRoute = async (page: Page, route: (typeof routes)[number]) => {
  if (route.session) {
    await page.goto("/#/");
    await page.evaluate(
      (session) =>
        localStorage.setItem("112233:session:v1", JSON.stringify(session)),
      route.session,
    );
  }
  await page.goto(route.path);
  await page
    .locator(".route-loading")
    .waitFor({ state: "detached" })
    .catch(() => undefined);
  if (route.name === "mapa")
    await page.locator(".leaflet-map-canvas").waitFor({ state: "visible" });
};

const assertNoSeriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page })
    .exclude(".leaflet-map-canvas")
    .analyze();
  expect(
    results.violations.filter(
      (item) => item.impact === "serious" || item.impact === "critical",
    ),
  ).toEqual([]);
};

for (const route of routes) {
  test(`axe sin impactos serious/critical: ${route.name}`, async ({ page }) => {
    await openRoute(page, route);
    await assertNoSeriousViolations(page);
  });
}

for (const route of routes.filter((item) =>
  [
    "inicio",
    "resultados",
    "mapa",
    "detalle",
    "publicar",
    "administración",
  ].includes(item.name),
)) {
  test(`axe móvil 390px sin impactos serious/critical: ${route.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoute(page, route);
    await assertNoSeriousViolations(page);
  });
}
