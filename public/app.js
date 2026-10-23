const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
});
const decimal = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const quantityFormat = new Intl.NumberFormat("fr-FR", {
  maximumFractionDigits: 8,
});
const percent = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const providerNames = {
  okx: "OKX",
  kraken: "Kraken",
  coinbase: "Coinbase",
  gomining: "GoMining",
};
const colors = [
  "#248b70",
  "#9180ba",
  "#6885ce",
  "#d6a959",
  "#75ada6",
  "#c17b83",
];
const assetInfo = {
  BTC: { name: "Bitcoin", image: "1/small/bitcoin.png" },
  ETH: { name: "Ethereum", image: "279/small/ethereum.png" },
  SOL: { name: "Solana", image: "4128/small/solana.png" },
  USDT: { name: "Tether", image: "325/small/Tether.png" },
  USDC: { name: "USD Coin", image: "6319/small/usdc.png" },
  EUR: { name: "Euro" },
  USD: { name: "Dollar am\u00e9ricain" },
  GOMINING: { name: "GoMining Token" },
};
const state = {
  portfolio: null,
  session: null,
  period: "30",
  account: "all",
  historyPage: 0,
  deleting: null,
  collecting: false,
};
let historyChart;
let allocationChart;
let toastTimer;
let goMiningCallback = location.hash.startsWith("#gomining-callback?")
  ? new URLSearchParams(location.hash.slice("#gomining-callback?".length))
  : null;
if (goMiningCallback) history.replaceState(null, "", "/#accounts");
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const icons = () => lucide.createIcons({ attrs: { "aria-hidden": "true" } });
const icon = (name, className = "") =>
  `<i data-lucide="${name}" class="${className}"></i>`;
const accountName = (account) => escapeHtml(account.name);
const accountScope = (account) =>
  account.provider === "gomining" ? "Wallet" : "Spot";
const providerLogo = (provider) =>
  `<span class="provider-logo provider-${provider}">${icon(provider === "okx" ? "blocks" : provider === "kraken" ? "waves" : provider === "gomining" ? "pickaxe" : "circle-dollar-sign")}</span>`;

async function api(route, options = {}) {
  const response = await fetch(`/api${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Le serveur est indisponible.");
  }
  if (!response.ok) {
    if (response.status === 401 && route !== "/login") showLogin();
    throw new Error(result.error || "La requ\u00eate a \u00e9chou\u00e9.");
  }
  return result;
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 5000);
}

function showLogin() {
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#login-screen").hidden = false;
  $("#login-password").focus();
}

async function loadPortfolio() {
  state.portfolio = await api("/portfolio");
  $("#error-banner").hidden = true;
  render();
}

function showError(error) {
  $("#error-banner").textContent = error.message;
  $("#error-banner").hidden = false;
}

function filteredPoints() {
  const source =
    state.account === "all"
      ? state.portfolio.history
      : (state.portfolio.accounts.find(
          (account) => account.id === state.account,
        )?.history ?? []);
  if (state.period === "all") return source;
  const cutoff = Date.now() - Number(state.period) * 86400000;
  return source.filter((point) => new Date(point.time).getTime() >= cutoff);
}

function selectedAccounts() {
  return state.account === "all"
    ? state.portfolio.accounts
    : state.portfolio.accounts.filter(
        (account) => account.id === state.account,
      );
}

function changeValue(points) {
  if (points.length < 2) return null;
  const start = points[0].total;
  const difference = points.at(-1).total - start;
  return {
    difference,
    percentage: start ? (difference / Math.abs(start)) * 100 : null,
  };
}

function render() {
  const { accounts } = state.portfolio;
  if (
    state.account !== "all" &&
    !accounts.some((account) => account.id === state.account)
  )
    state.account = "all";
  $("#account-count").textContent = accounts.length;
  $("#section-account-count").textContent = accounts.length;
  $("#accounts-summary").textContent =
    `${accounts.length} compte${accounts.length > 1 ? "s" : ""}`;
  const options =
    '<option value="all">Tous les comptes</option>' +
    accounts
      .map(
        (account) =>
          `<option value="${account.id}">${accountName(account)}</option>`,
      )
      .join("");
  const historySelection = $("#history-filter").value;
  $("#account-filter").innerHTML = options;
  $("#account-filter").value = state.account;
  $("#history-filter").innerHTML = options;
  $("#history-filter").value = accounts.some(
    (account) => account.id === historySelection,
  )
    ? historySelection
    : "all";
  renderOverview();
  renderAccountList();
  renderHistory();
  icons();
}

function renderOverview() {
  const accounts = selectedAccounts();
  const total = accounts.reduce(
    (sum, account) => sum + (account.snapshot?.total ?? 0),
    0,
  );
  $("#total-balance").innerHTML = `${decimal.format(total)} <span>EUR</span>`;
  $(".balance-label").firstChild.textContent =
    state.account === "all" ? "Solde total " : "Solde du compte ";
  const points = filteredPoints();
  const change = changeValue(points);
  const changeElement = $("#total-change");
  changeElement.className = `change-pill ${!change ? "neutral" : change.difference < 0 ? "negative" : ""}`;
  changeElement.innerHTML = change
    ? `${icon(change.difference < 0 ? "trending-down" : "trending-up")} ${change.difference >= 0 ? "+" : ""}${euro.format(change.difference)}${change.percentage === null ? "" : ` (${change.percentage >= 0 ? "+" : ""}${percent.format(change.percentage)} %)`}`
    : "Pas encore de variation";
  $("#change-caption").textContent =
    state.period === "all"
      ? "depuis le premier relev\u00e9"
      : `sur ${state.period} jours`;
  const capturedTimes = accounts
    .filter((account) => account.snapshot)
    .map((account) => account.snapshot.captured_at)
    .sort();
  const stale = accounts.some(
    (account) =>
      account.last_error ||
      !account.snapshot ||
      Date.now() - new Date(account.snapshot.captured_at).getTime() >
        state.session.intervalMinutes * 120000,
  );
  const status = $("#sync-status");
  status.classList.toggle("stale", stale);
  status.innerHTML = `<span class="status-dot"></span>${state.session.demo ? "Relev\u00e9s fictifs" : stale ? "Relev\u00e9s \u00e0 v\u00e9rifier" : capturedTimes.length ? `Relev\u00e9 le ${dateFormat.format(new Date(capturedTimes[0]))}` : "En attente de collecte"}`;
  const failedAccounts = state.portfolio.accounts.filter(
    (account) => account.last_error,
  );
  if (failedAccounts.length) {
    $("#error-banner").textContent =
      `${failedAccounts.length} compte(s) en erreur. Le total inclut les derniers soldes connus. D\u00e9tails dans Mes comptes.`;
    $("#error-banner").hidden = false;
  }
  $("#chart-points").textContent =
    `${points.length} relev\u00e9${points.length > 1 ? "s" : ""}`;
  $("#chart-empty").hidden = points.length > 0;
  renderLineChart(points);
  renderAllocation();
  renderAccountCards();
  renderAssets(accounts);
}

function renderLineChart(points) {
  historyChart?.destroy();
  historyChart = new Chart($("#history-chart"), {
    type: "line",
    data: {
      labels: points.map((point) =>
        new Date(point.time).toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "short",
        }),
      ),
      datasets: [
        {
          data: points.map((point) => point.total),
          borderColor: "#248b70",
          borderWidth: 2,
          pointRadius: points.length === 1 ? 4 : 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: "#248b70",
          pointHoverBorderColor: "#fff",
          pointHoverBorderWidth: 2,
          tension: 0,
          fill: true,
          backgroundColor(context) {
            const chart = context.chart;
            const area = chart.chartArea;
            if (!area) return "transparent";
            const gradient = chart.ctx.createLinearGradient(
              0,
              area.top,
              0,
              area.bottom,
            );
            gradient.addColorStop(0, "rgba(36,139,112,0.12)");
            gradient.addColorStop(1, "rgba(36,139,112,0.005)");
            return gradient;
          },
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 500,
      },
      interaction: { intersect: false, mode: "index" },
      layout: { padding: { top: 10, right: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: !document.body.classList.contains("private"),
          displayColors: false,
          backgroundColor: "#263c30",
          padding: 11,
          titleFont: { family: "DM Sans", size: 10, weight: "normal" },
          bodyFont: { family: "Space Grotesk", size: 13 },
          callbacks: {
            title: (items) =>
              dateFormat.format(new Date(points[items[0].dataIndex].time)),
            label: (context) => euro.format(context.parsed.y),
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: "#a1aba3",
            maxTicksLimit: innerWidth < 700 ? 5 : 6,
            maxRotation: 0,
            font: { family: "DM Sans", size: 9 },
          },
        },
        y: {
          position: "right",
          border: { display: false },
          grid: { color: "#eaf0eb", drawTicks: false },
          ticks: {
            padding: 10,
            color: "#a1aba3",
            count: 5,
            font: { family: "DM Sans", size: 9 },
            callback: (value) =>
              document.body.classList.contains("private")
                ? "\u2022\u2022\u2022"
                : new Intl.NumberFormat("fr-FR", {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(value),
          },
        },
      },
    },
  });
}

function renderAllocation() {
  const accounts = state.portfolio.accounts;
  const total = state.portfolio.total;
  allocationChart?.destroy();
  allocationChart = new Chart($("#allocation-chart"), {
    type: "doughnut",
    data: {
      labels: accounts.map((account) => account.name),
      datasets: [
        {
          data:
            total > 0
              ? accounts.map((account) =>
                  Math.max(0, account.snapshot?.total ?? 0),
                )
              : [1],
          backgroundColor:
            total > 0
              ? accounts.map((account, index) => colors[index % colors.length])
              : ["#e8eee9"],
          borderWidth: accounts.length > 1 ? 4 : 0,
          borderColor: "#f8faf9",
          borderRadius: 2,
          hoverOffset: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "80%",
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: total > 0 && !document.body.classList.contains("private"),
          displayColors: false,
          callbacks: { label: (context) => euro.format(context.parsed) },
        },
      },
    },
  });
  $("#donut-count").textContent = accounts.length;
  $("#donut-caption").textContent =
    accounts.length === 1 ? "compte" : "comptes";
  $("#allocation-legend").innerHTML =
    accounts
      .map(
        (account, index) =>
          `<div class="allocation-row"><span class="dot" style="background:${colors[index % colors.length]}"></span><span class="allocation-name" title="${accountName(account)}">${accountName(account)}</span><strong class="money">${euro.format(account.snapshot?.total ?? 0)}</strong><span class="percent">${percent.format(total > 0 ? ((account.snapshot?.total ?? 0) / total) * 100 : 0)} %</span></div>`,
      )
      .join("") || '<span class="muted">Aucun compte</span>';
}

function renderAccountCards() {
  $("#account-cards").innerHTML =
    state.portfolio.accounts
      .map(
        (account) =>
          `<button class="account-card ${state.account === account.id ? "selected" : ""}" data-select-account="${account.id}" title="Afficher le graphique de ${accountName(account)}"><div class="account-card-top">${providerLogo(account.provider)}<span class="account-card-title"><strong>${accountName(account)}</strong><span>${providerNames[account.provider]} &middot; ${accountScope(account)}</span></span>${icon("arrow-up-right", "card-arrow")}</div><div class="card-value money">${account.snapshot ? decimal.format(account.snapshot.total) : "\u2014"} <small>EUR</small></div><div class="card-bottom"><span class="connected ${account.last_error ? "issue" : ""}"><span class="status-dot"></span>${state.session.demo ? "D\u00e9monstration" : account.last_error ? "\u00c0 v\u00e9rifier" : account.snapshot ? "Synchronis\u00e9" : "En attente"}</span><span>${account.snapshot ? dateFormat.format(new Date(account.snapshot.captured_at)) : "Aucun relev\u00e9"}</span></div></button>`,
      )
      .join("") ||
    `<button class="no-data-card" data-add-account>${icon("plus")} Ajouter mon premier compte</button>`;
}

function renderAssets(accounts) {
  const assets = new Map();
  for (const account of accounts) {
    for (const holding of account.snapshot?.holdings ?? []) {
      const item = assets.get(holding.asset) ?? {
        asset: holding.asset,
        quantity: 0,
        value: 0,
      };
      item.quantity += holding.quantity;
      item.value += holding.quantity * holding.price;
      assets.set(holding.asset, item);
    }
  }
  const items = [...assets.values()].sort(
    (first, second) => second.value - first.value,
  );
  const total = items.reduce((sum, item) => sum + item.value, 0);
  $("#asset-count").textContent =
    `${items.length} actif${items.length > 1 ? "s" : ""}`;
  $("#assets-empty").hidden = items.length > 0;
  $("#assets-body").innerHTML = items
    .map((item) => {
      const info = assetInfo[item.asset] ?? { name: item.asset };
      const share = total > 0 ? (item.value / total) * 100 : 0;
      const image = info.image
        ? `<img class="asset-icon" src="https://coin-images.coingecko.com/coins/images/${info.image}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="asset-fallback">${escapeHtml(item.asset === "EUR" ? "\u20ac" : item.asset.slice(0, 1))}</span>`;
      return `<tr><td><div class="asset-cell">${image}<div class="asset-label"><strong>${escapeHtml(info.name)}</strong><span>${escapeHtml(item.asset)}</span></div></div></td><td class="money">${quantityFormat.format(item.quantity)} <span class="muted">${escapeHtml(item.asset)}</span></td><td class="money">${euro.format(item.value)}</td><td><div class="asset-allocation"><div class="allocation-bar"><span style="width:${Math.max(0, Math.min(100, share))}%"></span></div><span class="asset-percent">${percent.format(share)} %</span></div></td></tr>`;
    })
    .join("");
  $$(".asset-icon").forEach((image) =>
    image.addEventListener(
      "error",
      () => {
        const fallback = document.createElement("span");
        fallback.className = "asset-fallback";
        fallback.textContent = image.parentElement.textContent
          .trim()
          .slice(0, 1);
        image.replaceWith(fallback);
      },
      { once: true },
    ),
  );
}

function renderAccountList() {
  $("#no-accounts").hidden = state.portfolio.accounts.length > 0;
  $("#account-list").innerHTML = state.portfolio.accounts
    .map(
      (account) =>
        `<article class="account-detail"><div class="account-card-top">${providerLogo(account.provider)}<div class="account-card-title"><strong>${accountName(account)}</strong><span>${providerNames[account.provider]} &middot; ${accountScope(account)}</span><a href="#overview" class="text-link" data-select-account="${account.id}">Voir l'historique ${icon("arrow-up-right")}</a></div></div><div class="account-detail-meta"><div class="account-detail-value"><strong class="money">${account.snapshot ? euro.format(account.snapshot.total) : "\u2014"}</strong><span>${account.snapshot ? dateFormat.format(new Date(account.snapshot.captured_at)) : "Aucun relev\u00e9"}</span></div>${account.provider === "gomining" ? `<button class="icon-button" data-reconnect-gomining="${account.id}" title="Renouveler la connexion GoMining" aria-label="Renouveler la connexion GoMining" ${state.session.demo ? "disabled" : ""}>${icon("link-2")}</button>` : ""}<button class="icon-button" data-delete-account="${account.id}" title="Supprimer ${accountName(account)}" aria-label="Supprimer ${accountName(account)}" ${state.session.demo ? "disabled" : ""}>${icon("trash-2")}</button></div>${account.last_error ? `<p class="account-detail-error">${icon("triangle-alert")}${escapeHtml(account.last_error)}</p>` : ""}</article>`,
    )
    .join("");
}

function renderHistory() {
  if (!state.portfolio) return;
  const filter = $("#history-filter").value;
  const days = $("#history-days").value;
  const cutoff = days === "all" ? 0 : Date.now() - Number(days) * 86400000;
  const rows = state.portfolio.accounts
    .filter((account) => filter === "all" || account.id === filter)
    .flatMap((account) =>
      account.history.map((point) => ({ ...point, account })),
    )
    .filter((point) => new Date(point.time).getTime() >= cutoff)
    .sort((first, second) => second.time.localeCompare(first.time));
  const pageSize = 15;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.historyPage = Math.min(state.historyPage, pages - 1);
  const visible = rows.slice(
    state.historyPage * pageSize,
    (state.historyPage + 1) * pageSize,
  );
  $("#history-body").innerHTML =
    visible
      .map(
        (point) =>
          `<tr><td>${dateFormat.format(new Date(point.time))}</td><td class="history-account" title="${accountName(point.account)}">${accountName(point.account)}</td><td>${providerNames[point.account.provider]}</td><td class="money">${euro.format(point.total)}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="4" class="empty-line">Aucun relev\u00e9 sur cette p\u00e9riode.</td></tr>';
  $("#history-info").textContent =
    `${rows.length} relev\u00e9${rows.length > 1 ? "s" : ""} \u00b7 Page ${state.historyPage + 1} / ${pages}`;
  $("#history-prev").disabled = state.historyPage === 0;
  $("#history-next").disabled = state.historyPage >= pages - 1;
}

function navigate() {
  const titles = {
    overview: "Vue d'ensemble",
    accounts: "Mes comptes",
    history: "Historique",
    settings: "Param\u00e8tres",
  };
  const view =
    location.hash.slice(1) in titles ? location.hash.slice(1) : "overview";
  $$(".view").forEach((element) => {
    element.hidden = element.id !== `view-${view}`;
  });
  $$("[data-view]").forEach((element) => {
    element.classList.toggle("active", element.dataset.view === view);
    if (element.dataset.view === view)
      element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  });
  $("#page-title").innerHTML =
    `${titles[view]}<span class="title-dot">.</span>`;
  $("#breadcrumb-title").textContent = titles[view];
  $("#add-account").hidden = !["overview", "accounts"].includes(view);
  if (view === "overview") {
    historyChart?.resize();
    allocationChart?.resize();
  }
}

function openAccount() {
  if (state.session.demo)
    return toast(
      "Mode d\u00e9monstration : les comptes r\u00e9els sont d\u00e9sactiv\u00e9s.",
    );
  $("#account-form").reset();
  $("#account-error").textContent = "";
  updateProvider();
  $("#account-dialog").showModal();
}

function updateProvider() {
  const provider = $("#provider").value;
  const oauth = provider === "gomining";
  $("#api-credentials").hidden = oauth;
  $$("#api-credentials input, #api-credentials textarea").forEach((field) => {
    field.disabled = oauth;
  });
  $("#connection-security").textContent = oauth
    ? "Autorisation GoMining en lecture seule."
    : "Droits de lecture seule uniquement. Aucun droit de trading ou de retrait.";
  $("#connect-account-label").textContent = oauth
    ? "Continuer avec GoMining"
    : "Connecter le compte";
  $("#passphrase-field").hidden = provider !== "okx";
  $("#passphrase").required = provider === "okx";
  $("#account-name").placeholder = `Mon compte ${providerNames[provider]}`;
  $("#secret-label").textContent =
    provider === "coinbase"
      ? "Cl\u00e9 priv\u00e9e CDP (ECDSA / PEM)"
      : "Secret API";
}

async function authorizeGoMining({ name, accountId }) {
  const result = await api("/gomining/authorize", {
    method: "POST",
    body: JSON.stringify({ name, accountId }),
  });
  location.assign(result.authorizationUrl);
}

async function finishGoMining() {
  const params = goMiningCallback;
  goMiningCallback = null;
  try {
    toast("Validation de la connexion GoMining...");
    await api("/gomining/callback", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(params)),
    });
    await loadPortfolio();
    await collect();
  } catch (error) {
    showError(error);
  }
}

async function collect() {
  if (state.session.demo)
    return toast("Mode d\u00e9monstration : aucun appel aux plateformes.");
  if (state.collecting) return;
  state.collecting = true;
  $("#collect").disabled = true;
  $("#collect").innerHTML =
    `${icon("refresh-cw", "spinning")}<span>Collecte...</span>`;
  icons();
  try {
    const result = await api("/collect", { method: "POST", body: "{}" });
    await loadPortfolio();
    const failed = result.results.filter((item) => !item.ok).length;
    toast(
      failed
        ? `${failed} compte(s) en erreur. Derniers soldes conserv\u00e9s.`
        : result.results.length
          ? "Soldes actualis\u00e9s."
          : "Aucun compte \u00e0 collecter.",
    );
  } catch (error) {
    showError(error);
  } finally {
    state.collecting = false;
    $("#collect").disabled = false;
    $("#collect").innerHTML = `${icon("refresh-cw")}<span>Actualiser</span>`;
    icons();
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#login-password").value }),
    });
    $("#login-password").value = "";
    await initialize();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST", body: "{}" });
    state.portfolio = null;
    historyChart?.destroy();
    allocationChart?.destroy();
    showLogin();
  } catch (error) {
    toast(error.message);
  }
});

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  $("#account-error").textContent = "";
  try {
    if ($("#provider").value === "gomining") {
      await authorizeGoMining({ name: $("#account-name").value });
      return;
    }
    await api("/accounts", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    $("#account-dialog").close();
    event.target.reset();
    await loadPortfolio();
    await collect();
  } catch (error) {
    $("#account-error").textContent = error.message;
  } finally {
    event.submitter.disabled = false;
  }
});

$("#confirm-delete").addEventListener("click", async () => {
  $("#confirm-delete").disabled = true;
  try {
    await api(`/accounts/${state.deleting}`, { method: "DELETE", body: "{}" });
    $("#confirm-dialog").close();
    await loadPortfolio();
    toast("Compte et historique supprim\u00e9s.");
  } catch (error) {
    $("#delete-error").textContent = error.message;
  } finally {
    $("#confirm-delete").disabled = false;
  }
});

document.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add-account]");
  if (add) openAccount();
  const close = event.target.closest("[data-close]");
  if (close) document.getElementById(close.dataset.close).close();
  const select = event.target.closest("[data-select-account]");
  if (select) {
    state.account = select.dataset.selectAccount;
    location.hash = "overview";
    render();
  }
  const remove = event.target.closest("[data-delete-account]");
  if (remove && !state.session.demo) {
    state.deleting = remove.dataset.deleteAccount;
    $("#delete-error").textContent = "";
    $("#confirm-dialog").showModal();
  }
  const reconnect = event.target.closest("[data-reconnect-gomining]");
  if (reconnect && !state.session.demo) {
    reconnect.disabled = true;
    authorizeGoMining({ accountId: reconnect.dataset.reconnectGomining }).catch(
      (error) => {
        reconnect.disabled = false;
        showError(error);
      },
    );
  }
  const period = event.target.closest("[data-period]");
  if (period) {
    state.period = period.dataset.period;
    $$("[data-period]").forEach((button) => {
      button.classList.toggle("active", button === period);
      button.setAttribute("aria-pressed", String(button === period));
    });
    renderOverview();
    icons();
  }
});

$("#add-account").addEventListener("click", openAccount);
$("#provider").addEventListener("change", updateProvider);
$("#collect").addEventListener("click", collect);
$("#account-filter").addEventListener("change", (event) => {
  state.account = event.target.value;
  renderOverview();
  icons();
});
$("#history-filter").addEventListener("change", () => {
  state.historyPage = 0;
  renderHistory();
});
$("#history-days").addEventListener("change", () => {
  state.historyPage = 0;
  renderHistory();
});
$("#history-prev").addEventListener("click", () => {
  state.historyPage--;
  renderHistory();
});
$("#history-next").addEventListener("click", () => {
  state.historyPage++;
  renderHistory();
});
$("#privacy").addEventListener("click", () => {
  const hidden = document.body.classList.toggle("private");
  $("#privacy").innerHTML = icon(hidden ? "eye-off" : "eye");
  $("#privacy").title = hidden
    ? "Afficher les montants"
    : "Masquer les montants";
  $("#privacy").setAttribute("aria-label", $("#privacy").title);
  $("#privacy").setAttribute("aria-pressed", String(hidden));
  renderOverview();
  icons();
});
window.addEventListener("hashchange", navigate);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.portfolio) loadPortfolio().catch(showError);
});
setInterval(() => {
  if (!document.hidden && state.portfolio && !state.collecting)
    loadPortfolio().catch(showError);
}, 60000);

async function initialize() {
  icons();
  try {
    state.session = await api("/session");
    $("#boot").hidden = true;
    if (!state.session.authenticated) return showLogin();
    $("#login-screen").hidden = true;
    $("#app").hidden = false;
    $("#demo-badge").hidden = !state.session.demo;
    $("#demo-notice").hidden = !state.session.demo;
    $("#logout").hidden = state.session.demo;
    $("#today").textContent = new Date()
      .toLocaleDateString("fr-FR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
      .toUpperCase();
    $("#setting-interval").textContent =
      `${state.session.intervalMinutes} minutes`;
    $("#setting-timezone").textContent =
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    $("#setting-mode").textContent = state.session.demo
      ? "D\u00e9monstration (donn\u00e9es fictives)"
      : "Personnel";
    navigate();
    await loadPortfolio();
    if (goMiningCallback) await finishGoMining();
  } catch (error) {
    $("#boot").hidden = true;
    if (!state.portfolio && !state.session?.authenticated) {
      showLogin();
      $("#login-error").textContent = error.message;
    } else showError(error);
  }
}
initialize();
