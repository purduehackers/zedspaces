import DashboardLayout from "./(dashboard)/layout";
import WorkspacesPage from "./(dashboard)/workspaces/page";

export const dynamic = "force-dynamic";

export default function Home() {
  return <DashboardLayout><WorkspacesPage /></DashboardLayout>;
}
