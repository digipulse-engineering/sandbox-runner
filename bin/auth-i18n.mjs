const fallback = "en";

function supportedLocale(value) {
  if (!value) return;
  try {
    const { language } = new Intl.Locale(value);
    if (language === "en" || language === "fr") return language;
  } catch {
    // An unrecognized locale is a preference miss.
  }
}

function localeSetting(value) {
  return supportedLocale(value.trim().split(/[.@]/u, 1)[0].replaceAll("_", "-"));
}

export function terminalAuthLocale(env) {
  const locale = [env.SANDBOX_RUNNER_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]
    .find(value => value?.trim());
  return locale ? localeSetting(locale) ?? fallback : fallback;
}

export function browserAuthLocale(header, env) {
  if (env.SANDBOX_RUNNER_LANG?.trim()) return localeSetting(env.SANDBOX_RUNNER_LANG) ?? fallback;
  if (typeof header !== "string") return fallback;
  let best;
  let bestWeight = 0;
  let wildcardWeight = 0;
  const matched = new Set();
  for (const entry of header.split(",")) {
    const [range, parameter, extra] = entry.trim().split(";");
    const weight = parameter === undefined ? 1
      : Number(/^\s*q\s*=\s*(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(parameter)?.[1]);
    if (extra !== undefined || Number.isNaN(weight)) continue;
    if (range.trim() === "*") {
      wildcardWeight = Math.max(wildcardWeight, weight);
      continue;
    }
    const locale = supportedLocale(range.trim());
    if (!locale) continue;
    matched.add(locale);
    if (weight > bestWeight) {
      best = locale;
      bestWeight = weight;
    }
  }
  const wildcardLocale = ["en", "fr"].find(locale => !matched.has(locale));
  return wildcardLocale && wildcardWeight > bestWeight ? wildcardLocale : best ?? fallback;
}

// Canonical English diagnostics also appear in JSON. Translate only the human
// output, keeping the machine-facing messages and identifiers stable.
const french = {
  "OpenAI blocked Codex API-key access for this organization because of its API credits promotion. Configure a key from an eligible API organization or explicitly select subscription authentication.":
    "OpenAI bloque l’accès à Codex par clé API pour cette organisation en raison de sa promotion de crédits API. Configurez une clé d’une organisation API éligible ou sélectionnez explicitement l’authentification par abonnement.",
  "The connector authorization changed during the run. Inspect the run before submitting another one.":
    "L’autorisation du connecteur a changé pendant l’exécution. Vérifiez le résultat avant de soumettre une nouvelle exécution.",
  "API key": "Clé API",
  "Subscription": "Abonnement",
  "read-only": "lecture seule",
  "read-write": "lecture et écriture",
  "Credential input": "Saisie de l’identifiant",
  "Run claude setup-token in a private terminal.": "Exécutez claude setup-token dans un terminal privé.",
  "Paste the token, then press Enter and Ctrl-D.": "Collez le jeton, puis appuyez sur Entrée et Ctrl-D.",
  "Paste the API key, then press Enter and Ctrl-D.": "Collez la clé API, puis appuyez sur Entrée et Ctrl-D.",
  "Input is hidden. Ctrl-C cancels.": "La saisie est masquée. Ctrl-C annule.",
  "Run claude setup-token in a private terminal. Paste the token here, then press Enter and Ctrl-D.":
    "Exécutez claude setup-token dans un terminal privé. Collez le jeton ici, puis appuyez sur Entrée et Ctrl-D.",
  "Paste the API key here, then press Enter and Ctrl-D.": "Collez la clé API ici, puis appuyez sur Entrée et Ctrl-D.",
  "Checking Cloudflare Worker…": "Vérification du Worker Cloudflare…",
  "Rechecking Cloudflare Worker…": "Nouvelle vérification du Worker Cloudflare…",
  "Publishing credential…": "Publication de l’identifiant…",
  "Publishing connector credential…": "Publication de l’identifiant du connecteur…",
  "Verifying active Worker version…": "Vérification de la version active du Worker…",
  "Credential configured. Active Worker version verified.": "Identifiant configuré. Version active du Worker vérifiée.",
  "Connector credential configured. Active Worker version verified.": "Identifiant du connecteur configuré. Version active du Worker vérifiée.",
  "Approve Claude in your browser.": "Autorisez Claude dans votre navigateur.",
  "If it provides an authorization code, paste it in full and press Enter.":
    "Si un code d’autorisation s’affiche, collez-le en entier et appuyez sur Entrée.",
  "Claude setup-token returned a credential.": "Claude setup-token a renvoyé un identifiant.",
  "Claude setup-token diagnostic: ": "Diagnostic de Claude setup-token ",
  "Continue with masked input.": "Continuez avec la saisie masquée.",
  "Automatic Claude setup-token requires macOS.": "La récupération automatique via Claude setup-token nécessite macOS.",
  "The configured Claude executable is invalid.": "L’exécutable Claude configuré est invalide.",
  "The Claude executable could not be found.": "L’exécutable Claude est introuvable.",
  "Could not start the Claude setup-token terminal.": "Impossible de lancer le terminal Claude setup-token.",
  "Could not prepare the Claude setup-token terminal.": "Impossible de préparer le terminal Claude setup-token.",
  "Claude setup-token timed out.": "Le délai de Claude setup-token est dépassé.",
  "Claude setup-token stopped before returning a credential.": "Claude setup-token s’est arrêté avant de renvoyer un identifiant.",
  "Claude setup-token exited unsuccessfully.": "Claude setup-token s’est terminé en erreur.",
  "Claude setup-token did not return a verifiable credential.": "Claude setup-token n’a pas renvoyé d’identifiant vérifiable.",
  "Approve the connector in your browser. Ctrl-C cancels.": "Autorisez le connecteur dans votre navigateur. Ctrl-C annule.",
  "Open this link in a browser on this computer:": "Ouvrez ce lien dans un navigateur sur cet ordinateur.",
  "Authorization received. Return to sandbox-runner.": "Autorisation reçue. Revenez à sandbox-runner.",
  "Authorization did not complete.": "L’autorisation n’a pas abouti.",
  "Codex authorization did not complete.": "L’autorisation Codex n’a pas abouti.",

  "Invalid auth arguments. Use sandbox-runner --help for usage.": "Arguments d’authentification invalides. Consultez sandbox-runner --help.",
  "Each auth option can be supplied once.": "Chaque option d’authentification peut être fournie une seule fois.",
  "Use --model-provider openai or anthropic for OpenCode auth.": "Utilisez --model-provider openai ou anthropic pour authentifier OpenCode.",
  "Auth requires one agent and --mode subscription or api-key.": "Indiquez un agent et --mode subscription ou api-key.",
  "Provide a Cloudflare account ID with --account or CLOUDFLARE_ACCOUNT_ID.":
    "Indiquez un identifiant de compte Cloudflare avec --account ou CLOUDFLARE_ACCOUNT_ID.",
  "Provide a Worker name with --worker or SANDBOX_RUNNER_WORKER.": "Indiquez un nom de Worker avec --worker ou SANDBOX_RUNNER_WORKER.",
  "Provide a valid Cloudflare profile name.": "Indiquez un nom de profil Cloudflare valide.",
  "SANDBOX_RUNNER_CF_BIN must identify a cf executable.": "SANDBOX_RUNNER_CF_BIN doit désigner un exécutable cf.",
  "SANDBOX_RUNNER_TIMEOUT_MS must be between 1 and 2147483647.": "SANDBOX_RUNNER_TIMEOUT_MS doit être compris entre 1 et 2147483647.",
  "Auth requires a single Worker version serving 100% of traffic.":
    "L’authentification nécessite une seule version du Worker qui reçoit 100 % du trafic.",
  "The active Worker version could not be verified.": "Impossible de vérifier la version active du Worker.",
  "The active Worker does not have the required Sandbox Runner bindings.": "Il manque des liaisons Sandbox Runner sur le Worker actif.",
  "The active Worker has not enabled OpenCode.": "OpenCode est désactivé sur le Worker actif.",
  "The active Worker has no MCP connector registry.": "Le Worker actif ne dispose d’aucun registre de connecteurs MCP.",
  "Could not read terminal settings for masked input.": "Impossible de lire les réglages du terminal pour la saisie masquée.",
  "Could not enable masked input.": "Impossible d’activer la saisie masquée.",
  "Could not restore terminal settings.": "Impossible de restaurer les réglages du terminal.",
  "SANDBOX_RUNNER_CLAUDE_SETUP_TIMEOUT_MS must be between 1 and 2147483647.":
    "SANDBOX_RUNNER_CLAUDE_SETUP_TIMEOUT_MS doit être compris entre 1 et 2147483647.",
  "--manual requires interactive Claude subscription auth.": "--manual nécessite une authentification interactive par abonnement Claude.",
  "--stdin requires redirected input and a manual credential mode.": "--stdin nécessite une entrée redirigée et un mode d’authentification manuel.",
  "Use a terminal for masked auth or --stdin for redirected manual credentials.":
    "Utilisez un terminal pour la saisie masquée ou --stdin pour les identifiants fournis par redirection.",
  "Auth was interrupted.": "L’authentification a été interrompue.",
  "The Cloudflare command timed out.": "Le délai de la commande Cloudflare est dépassé.",
  "Could not verify the Worker with cf. Check Cloudflare login, account, and Worker name.":
    "Impossible de vérifier le Worker avec cf. Vérifiez la connexion à Cloudflare, le compte et le nom du Worker.",
  "The active Worker or its credentials changed during setup. Restart setup to verify the current target.":
    "Le Worker actif ou ses identifiants ont changé pendant la configuration. Relancez setup pour vérifier la cible actuelle.",
  "A credential update was already attempted.": "Une mise à jour de l’identifiant a déjà été tentée.",
  "Codex did not return a subscription access token.": "Codex n’a pas renvoyé de jeton d’accès par abonnement.",
  "The active Worker changed during auth. Start auth again for the current version.":
    "Le Worker actif a changé pendant l’authentification. Relancez auth pour la version actuelle.",
  "Could not confirm the credential update. Check the active Cloudflare Worker version before trying again.":
    "Impossible de confirmer la mise à jour de l’identifiant. Vérifiez la version active du Worker Cloudflare avant de réessayer.",
  "Could not prepare the private credential file.": "Impossible de préparer le fichier privé de l’identifiant.",
  "Could not complete Codex subscription auth.": "Impossible de terminer l’authentification par abonnement Codex.",
  "Could not read the credential.": "Impossible de lire l’identifiant.",
  "The credential format does not match the selected agent and mode.":
    "Le format de l’identifiant ne correspond pas à l’agent et au mode choisis.",
  "Use connector login NAME --mode read-only|read-write --scope SCOPES.":
    "Utilisez connector login NAME --mode read-only|read-write --scope SCOPES.",
  "SANDBOX_RUNNER_MCP_OAUTH_TIMEOUT_MS must be between 1 and 2147483647.":
    "SANDBOX_RUNNER_MCP_OAUTH_TIMEOUT_MS doit être compris entre 1 et 2147483647.",
  "Connector login requires an interactive terminal and browser.": "La connexion du connecteur nécessite un terminal interactif et un navigateur.",
  "Connector login was interrupted.": "La connexion du connecteur a été interrompue.",
  "The Worker has no OAuth credential binding for this connector and mode.":
    "Il manque une liaison d’identifiant OAuth sur le Worker pour ce connecteur et ce mode.",
  "Check the connector configuration on the Worker.": "Vérifiez la configuration du connecteur sur le Worker.",
  "Check the connector credentials configured on the Worker.": "Vérifiez les identifiants du connecteur configurés sur le Worker.",
  "The connector is rate limited. Wait before trying again.": "Le connecteur limite le débit. Patientez avant de réessayer.",
  "The connector is temporarily unavailable. Check its status before retrying.":
    "Le connecteur est temporairement indisponible. Vérifiez son état avant de réessayer.",
  "Reconnect the connector in your browser.": "Reconnectez le connecteur dans votre navigateur.",
  "The connector's credential refresh could not be confirmed. Reconnect in your browser.":
    "Le renouvellement de l’identifiant n’a pas pu être confirmé. Reconnectez le connecteur dans votre navigateur.",
  "Check the connector permissions and the run's access policy.":
    "Vérifiez les droits du connecteur et la politique d’accès du run.",
  "The run's access policy denied this connector operation.":
    "La politique d’accès du run a refusé cette opération sur le connecteur.",
  "The requested tool is unavailable. Check the connector's tool catalog.":
    "L’outil demandé est indisponible. Vérifiez le catalogue du connecteur.",
  "The connector tool reported an error. Check the run events before retrying.":
    "L’outil du connecteur a renvoyé une erreur. Consultez les événements du run avant de réessayer.",
  "Verify the write at the connector before attempting it again.":
    "Vérifiez le résultat de l’écriture auprès du connecteur avant de la retenter.",
  "The connector rejected authentication. Check its credentials and access policy.":
    "Le connecteur a refusé l’authentification. Vérifiez ses identifiants et sa politique d’accès.",
  "Retry after (seconds)": "Délai avant réessai (secondes)",
  "Use the account and Worker for this Runner.": "Indiquez le compte et le Worker de ce Runner.",
  "The active Worker changed. Start connector login again.": "Le Worker actif a changé. Relancez connector login.",
  "The configured Cloudflare Worker does not match the Worker that rejected this run.":
    "Le Worker Cloudflare configuré diffère du Worker qui a refusé ce run.",
  "Cloudflare did not confirm the Runner URL belongs to this Worker.":
    "Cloudflare n’a pas confirmé que l’URL du Runner appartient à ce Worker.",
  "The verified Worker has no existing grant for this connector and mode.":
    "Le Worker vérifié ne dispose d’aucune autorisation pour ce connecteur et ce mode.",
  "Reconnect in the browser and retry this run? [y/N] ": "Reconnecter dans le navigateur puis relancer ce run ? [o/N] ",
  "Resource": "Ressource",
  "OAuth scopes": "Scopes OAuth",
  "The active Worker changed during consent. Start connector login again.": "Le Worker actif a changé pendant l’autorisation. Relancez connector login.",
  "Could not complete connector authorization.": "Impossible de terminer l’autorisation du connecteur.",
  "Could not verify the connector's OAuth resource and authorization server.":
    "Impossible de vérifier la ressource OAuth et le serveur d’autorisation du connecteur.",
  "The connector did not register a public OAuth client.": "Le connecteur n’a pas enregistré de client OAuth public.",
  "The local OAuth callback could not complete.": "Le retour OAuth local n’a pas abouti.",
  "Connector authorization was denied in the browser.": "L’autorisation du connecteur a été refusée dans le navigateur.",
  "Timed out waiting for connector authorization.": "Le délai d’autorisation du connecteur est dépassé.",
  "The connector did not return a renewable grant for the requested resource and scopes.":
    "Le connecteur n’a pas renvoyé d’autorisation renouvelable pour la ressource et les droits demandés.",
  "Codex subscription authorization requires an interactive terminal and browser.":
    "L’autorisation par abonnement Codex nécessite un terminal interactif et un navigateur.",
  "Check the Cloudflare target and Codex authorization settings.": "Vérifiez la cible Cloudflare et les paramètres d’autorisation Codex.",
  "Codex authorization could not access its private registration state.":
    "L’autorisation Codex n’a pas pu accéder aux données privées d’enregistrement.",
  "Another Codex authorization registered this Worker. Retry to use its registration.":
    "Une autre autorisation Codex a enregistré ce Worker. Réessayez pour utiliser cet enregistrement.",
  "The local Codex authorization callback could not complete.": "Le retour d’autorisation Codex local n’a pas abouti.",
  "Codex authorization was cancelled.": "L’autorisation Codex a été annulée.",
  "Timed out waiting for Codex authorization in the browser.": "Le délai d’autorisation Codex dans le navigateur est dépassé.",
  "Codex authorization was denied in the browser.": "L’autorisation Codex a été refusée dans le navigateur.",
  "Could not present the Codex authorization link.": "Impossible d’afficher le lien d’autorisation Codex.",
  "OpenAI did not complete the Codex authorization code exchange.": "OpenAI n’a pas terminé l’échange du code d’autorisation Codex.",
  "OpenAI did not grant ChatGPT plan usage for Codex.": "OpenAI n’a pas autorisé l’utilisation de l’abonnement ChatGPT pour Codex.",
  "Codex authorization could not verify the selected ChatGPT identity.": "Impossible de vérifier l’identité ChatGPT choisie pour Codex.",
  "Codex subscription authorization failed.": "L’autorisation par abonnement Codex a échoué.",
  "Sandbox Runner requires Node.js 24 or later.": "Sandbox Runner nécessite Node.js 24 ou une version ultérieure.",
  "The CLI could not complete the command.": "Impossible de terminer la commande.",
};

export function authText(locale, english) {
  return locale === "fr" && Object.hasOwn(french, english) ? french[english] : english;
}

export function sendAuthCallback(request, response, env, status, message, completed) {
  const locale = browserAuthLocale(request.headers["accept-language"], env);
  response.setHeader("content-language", locale);
  response.setHeader("vary", "Accept-Language");
  response.writeHead(status).end(authText(locale, message), completed);
}
