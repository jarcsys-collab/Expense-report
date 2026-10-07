import { HashRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { AppLayout } from "./components/layout/AppLayout";
import { ThemeProvider } from "./context/ThemeContext";
import { UploadQueueProvider } from "./context/UploadQueueContext";
import { WorkspaceProvider } from "./context/WorkspaceContext";
import { AssistantPage } from "./pages/AssistantPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ViolationsPage } from "./pages/ViolationsPage";

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <HashRouter>
          <WorkspaceProvider>
            <UploadQueueProvider>
              <Routes>
                <Route element={<AppLayout />}>
                  <Route index element={<Navigate to="/upload" replace />} />
                  {/* New expense: the Reimbursement Assistant. */}
                  <Route path="upload" element={<AssistantPage />} />
                  {/* Several receipts at once, or a long receipt in sections. */}
                  <Route path="upload/batch" element={<ExpensesPage upload />} />
                  <Route path="requests" element={<ExpensesPage />} />
                  <Route path="requests/:id" element={<ExpensesPage />} />
                  <Route
                    path="approvals"
                    element={<ExpensesPage approvals />}
                  />
                  <Route
                    path="approvals/:id"
                    element={<ExpensesPage approvals />}
                  />
                  <Route
                    path="dashboard"
                    element={<Navigate to="/requests" replace />}
                  />
                  <Route path="review/:id" element={<ReviewPage />} />
                  <Route path="violations" element={<ViolationsPage />} />
                  <Route path="categories" element={<CategoriesPage />} />
                  <Route path="profile" element={<ProfilePage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route
                    path="*"
                    element={
                      <div className="empty">
                        <h1>Page not found</h1>
                        <Link className="button primary" to="/upload">
                          Return to workspace
                        </Link>
                      </div>
                    }
                  />
                </Route>
              </Routes>
            </UploadQueueProvider>
          </WorkspaceProvider>
        </HashRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
