import {
  ClipboardList,
  MessageCirclePlus,
  Settings,
  ShieldCheck,
  Tags,
} from "lucide-react";

// `short` labels and `phone` are for the phone bottom navigation (< 640px);
// destinations without `phone` stay reachable from the Profile page there.
export function getNavItems(role, authenticated) {
  return [
    {
      to: "/upload",
      label: "New Expense",
      short: "New",
      phone: true,
      icon: MessageCirclePlus,
    },
    {
      to: "/requests",
      label: "My Requests",
      short: "Requests",
      phone: true,
      icon: ClipboardList,
    },
    ...(role !== "EMPLOYEE" || !authenticated
      ? [
          {
            to: "/approvals",
            label: "Approvals",
            short: "Approvals",
            phone: authenticated,
            icon: ShieldCheck,
          },
        ]
      : []),
    ...(role === "FINANCE_ADMIN" || !authenticated
      ? [
          {
            to: "/categories",
            label: "Categories",
            short: "Categories",
            icon: Tags,
          },
        ]
      : []),
    {
      to: "/violations",
      label: "Expense Issues",
      short: "Issues",
      phone: true,
      icon: ShieldCheck,
    },
    {
      to: "/settings",
      label: "Settings",
      short: "Settings",
      icon: Settings,
    },
  ];
}
