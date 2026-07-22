import { createBrowserRouter } from 'react-router';
import { AppLayout } from './AppLayout';
import { HomePage } from '@/features/home/HomePage';

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [{ path: '/', element: <HomePage /> }],
  },
]);
