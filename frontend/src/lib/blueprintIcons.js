import {
  BookOpen, Box, BrainCircuit, ChartColumn, Code, Database,
  FileArchive, FolderOpen, Gauge, Home, KeyRound, MonitorDown, Search,
  Shield, ShieldCheck, Workflow, Wrench,
} from 'lucide-vue-next';

/** blueprints.json 的 icon 字段(Emoji)映射为 Lucide 矢量图标组件。 */
const iconMap = {
  'nginx-proxy-manager': Shield,
  'uptime-kuma': Gauge,
  ollama: BrainCircuit,
  vaultwarden: KeyRound,
  alist: FolderOpen,
  meilisearch: Search,
  dufs: FileArchive,
  'rustdesk-server': MonitorDown,
  minio: Database,
  'grafana-prometheus': ChartColumn,
  'it-tools': Wrench,
  whoogle: Search,
  n8n: Workflow,
  gitea: Code,
  homepage: Home,
  'adguard-home': ShieldCheck,
  'calibre-web': BookOpen,
};

export function blueprintIcon(id) {
  return iconMap[id] || Box;
}
export default blueprintIcon;
