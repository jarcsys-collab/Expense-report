// Expense ownership comes from the server session, never from the browser.
// Verified Microsoft accounts own their name, email, department and job title;
// the temporary beta account still types department and position itself.
export function employeeFromSession(user, fields) {
  const verified = user.provider === "entra";
  const department = verified ? user.department : fields.department || "";
  const jobTitle = verified ? user.jobTitle : fields.position || "";
  return {
    employeeId: user.id,
    employeeName: user.name,
    department,
    position: jobTitle,
    employee: {
      provider: user.provider,
      entraUserId: verified ? user.id : "",
      displayName: user.name,
      email: user.email || "",
      department,
      jobTitle,
    },
  };
}
