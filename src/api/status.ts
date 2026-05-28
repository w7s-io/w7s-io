import type { Context } from "hono";
import type { Env } from "../env";

type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage";

type ComponentDefinition = {
  id: string;
  name: string;
  group: string;
  description: string;
  endpoint: string;
};

type StatusComponent = ComponentDefinition & {
  status: ComponentStatus;
  checked_at: string;
  updated_at: string;
};

type StatusIncident = {
  id: string;
  name: string;
  status: string;
  impact: "minor" | "major" | "critical";
  created_at: string;
  updated_at: string;
  components: string[];
  component_names: string[];
  incident_updates: Array<{
    status: string;
    body: string;
    created_at: string;
  }>;
};

const COMPONENTS: ComponentDefinition[] = [
  {
    id: "website",
    name: "W7S website",
    group: "Public delivery",
    description: "Landing page and public status surface on www.w7s.io.",
    endpoint: "www.w7s.io"
  },
  {
    id: "docs",
    name: "Documentation",
    group: "Public delivery",
    description: "Docusaurus documentation served from www.w7s.io/docs.",
    endpoint: "www.w7s.io/docs"
  },
  {
    id: "live-routing",
    name: "W7S Live routing",
    group: "Public delivery",
    description: "Public app routing on owner.w7s.cloud/repo paths.",
    endpoint: "*.w7s.cloud"
  },
  {
    id: "custom-domains",
    name: "Custom domains",
    group: "Public delivery",
    description: "Custom domain routing for W7S deployments.",
    endpoint: "custom domains"
  },
  {
    id: "cloud-api",
    name: "W7S Cloud API",
    group: "Control plane",
    description: "Deploy intake, health checks, and platform API routing.",
    endpoint: "w7s.cloud/api"
  },
  {
    id: "usage-observability",
    name: "Usage and observability APIs",
    group: "Control plane",
    description: "Usage limits, analytics, and log APIs with auth enforcement.",
    endpoint: "w7s.cloud/api/v1"
  },
  {
    id: "native-backends",
    name: "Native backend runtime",
    group: "Runtime features",
    description: "JavaScript and TypeScript backend request dispatch.",
    endpoint: "native backends"
  },
  {
    id: "stateful-objects",
    name: "Stateful objects",
    group: "Runtime features",
    description: "Persistent stateful coordination and storage bindings.",
    endpoint: "stateful objects"
  },
  {
    id: "backend-rpc",
    name: "Backend RPC",
    group: "Runtime features",
    description: "Internal backend-to-backend service calls.",
    endpoint: "W7S RPC"
  },
  {
    id: "queues",
    name: "Background queues",
    group: "Runtime features",
    description: "Managed queue delivery to JavaScript and TypeScript backends.",
    endpoint: "W7S queues"
  },
  {
    id: "schedules",
    name: "Cron schedules",
    group: "Runtime features",
    description: "Scheduled background dispatch to deployed backends.",
    endpoint: "W7S schedules"
  },
  {
    id: "workflows",
    name: "Durable workflows",
    group: "Runtime features",
    description: "Workflow instance dispatch and status retrieval.",
    endpoint: "W7S workflows"
  }
];

const validStatus = (status: unknown): status is ComponentStatus =>
  status === "operational" ||
  status === "degraded_performance" ||
  status === "partial_outage" ||
  status === "major_outage";

const parseJson = <T>(raw: string | undefined): T | null => {
  if (!raw?.trim()) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const componentStatusOverrides = (env: Env) => {
  const parsed = parseJson<Record<string, unknown>>(env.W7S_STATUS_COMPONENTS_JSON);
  if (!parsed) return {};

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, ComponentStatus] =>
      validStatus(entry[1])
    )
  );
};

const incidentOverrides = (env: Env) =>
  parseJson<StatusIncident[]>(env.W7S_STATUS_INCIDENTS_JSON) ?? [];

const statusHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

const statusRank: Record<ComponentStatus, number> = {
  operational: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3
};

const componentImpact = (status: ComponentStatus) => {
  if (status === "major_outage") return "major";
  if (status === "partial_outage") return "minor";
  if (status === "degraded_performance") return "minor";
  return "none";
};

const buildComponents = (env: Env, checkedAt: string): StatusComponent[] => {
  const overrides = componentStatusOverrides(env);

  return COMPONENTS.map((component) => ({
    ...component,
    status: overrides[component.id] ?? "operational",
    checked_at: checkedAt,
    updated_at: checkedAt
  }));
};

const overallStatus = (components: StatusComponent[], incidents: StatusIncident[]) => {
  const worstComponent = components.reduce<ComponentStatus>(
    (worst, component) =>
      statusRank[component.status] > statusRank[worst] ? component.status : worst,
    "operational"
  );
  const hasCriticalIncident = incidents.some((incident) => incident.impact === "critical");
  const hasMajorIncident = incidents.some((incident) => incident.impact === "major");
  const hasMinorIncident = incidents.some((incident) => incident.impact === "minor");

  if (hasCriticalIncident) {
    return {
      indicator: "critical",
      description: "Critical outage detected"
    };
  }

  if (worstComponent === "major_outage") {
    return {
      indicator: "major",
      description: "Active outage detected"
    };
  }

  if (hasMajorIncident || worstComponent === "partial_outage") {
    return {
      indicator: "minor",
      description: "Partial outage detected"
    };
  }

  if (hasMinorIncident || worstComponent === "degraded_performance") {
    return {
      indicator: "minor",
      description: "Some systems degraded"
    };
  }

  return {
    indicator: "none",
    description: "All systems operational"
  };
};

const componentIncidents = (components: StatusComponent[], checkedAt: string): StatusIncident[] => {
  const impacted = components.filter((component) => component.status !== "operational");
  if (!impacted.length) return [];

  const impact = impacted.reduce<"minor" | "major">((worst, component) => {
    const nextImpact = componentImpact(component.status);
    return nextImpact === "major" ? "major" : worst;
  }, "minor");

  return [
    {
      id: `component-status-${checkedAt}`,
      name: "W7S component status update",
      status: "investigating",
      impact,
      created_at: checkedAt,
      updated_at: checkedAt,
      components: impacted.map((component) => component.id),
      component_names: impacted.map((component) => component.name),
      incident_updates: [
        {
          status: "investigating",
          body: "One or more W7S components is currently not marked operational.",
          created_at: checkedAt
        }
      ]
    }
  ];
};

const statusSummary = (env: Env) => {
  const checkedAt = new Date().toISOString();
  const components = buildComponents(env, checkedAt);
  const incidents = [...incidentOverrides(env), ...componentIncidents(components, checkedAt)];

  return {
    page: {
      id: "w7s",
      name: "W7S",
      url: "https://www.w7s.io/status",
      time_zone: "Etc/UTC",
      updated_at: checkedAt
    },
    status: overallStatus(components, incidents),
    components,
    incidents,
    scheduled_maintenances: []
  };
};

export const handleStatusOptions = () =>
  new Response(null, {
    status: 204,
    headers: statusHeaders
  });

export const handleStatusGet = async (c: Context<{ Bindings: Env }>) =>
  new Response(JSON.stringify(statusSummary(c.env)), {
    status: 200,
    headers: statusHeaders
  });
