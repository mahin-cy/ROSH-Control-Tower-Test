import { createBrowserRouter, Navigate } from 'react-router';

import { AppLayout } from '@/layout/AppLayout';
import { AuthGate } from '@/components/AuthGate';
import { VehicleListPage } from '@/pages/VehicleListPage';
import { SessionHistoryPage } from '@/pages/SessionHistoryPage';
import { RunDetailPage } from '@/pages/RunDetailPage';
import LiveTelemetryPage from '@/pages/LiveTelemetryPage';
import { AdminPage } from '@/pages/AdminPage';
import LoginPage from '@/pages/LoginPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/vehicles" replace /> },
      {
        path: 'vehicles',
        element: (
          <AuthGate>
            <VehicleListPage />
          </AuthGate>
        )
      },
      {
        path: 'history',
        element: (
          <AuthGate>
            <SessionHistoryPage />
          </AuthGate>
        )
      },
      {
        path: 'vehicles/:vin/live',
        element: (
          <AuthGate>
            <LiveTelemetryPage />
          </AuthGate>
        )
      },
      {
        path: 'vehicles/:vin/runs/:runId',
        element: (
          <AuthGate>
            <RunDetailPage />
          </AuthGate>
        )
      },
      {
        path: 'admin',
        element: (
          <AuthGate requireRole="ADMIN">
            <AdminPage />
          </AuthGate>
        )
      }
    ]
  }
]);
