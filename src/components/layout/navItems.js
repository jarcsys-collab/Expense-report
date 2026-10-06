import {
  ClipboardList,
  Settings,
  ShieldCheck,
  Tags,
  Upload,
} from "lucide-react";

export function getNavItems(role, authenticated) {
  return [
    {
      to: "/upload",
      label: "Scan Receipt",
      icon: Upload,
    },
    {
      to: "/requests",
      label: "My Requests",
      icon: ClipboardList,
    },
    ...(role !== "EMPLOYEE" || !authenticated
      ? [
          {
            to: "/approvals",
            label: "Approvals",
            icon: ShieldCheck,
          },
        ]
      : []),
    ...(role === "FINANCE_ADMIN" || !authenticated
      ? [
          {
            to: "/categories",
            label: "Categories",
            icon: Tags,
          },
        ]
      : []),
    {
      to: "/violations",
      label: "Expense Issues",
      icon: ShieldCheck,
    },
    {
      to: "/settings",
      label: "Settings",
      icon: Settings,
    },
  ];
}
