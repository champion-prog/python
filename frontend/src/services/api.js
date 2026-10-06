const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '');
let accessToken = null;

export const setAccessToken = (token) => {
  accessToken = token;
};

export const hasApiConfiguration = () => Boolean(apiUrl);

export async function apiRequest(path, { method = 'GET', body, headers = {} } = {}) {
  if (!apiUrl) {
    throw new Error('AWS is not configured yet. Deploy the SAM stack and set VITE_API_URL in your .env file.');
  }
  if (!accessToken) {
    throw new Error('Sign in to use SmartQueue.');
  }

  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('SmartQueue could not reach AWS. Check your connection and try again.');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('SmartQueue received an invalid response. Please try again.');
  }

  if (!response.ok) {
    throw new Error(result.message ?? 'The request could not be completed.');
  }
  return result;
}

export const getOrganizations = () => apiRequest('/organizations');
export const getMyProfile = () => apiRequest('/users/me');
export const getDepartments = (organizationId) =>
  apiRequest(`/organizations/${encodeURIComponent(organizationId)}/departments`);
export const getServices = (organizationId) => apiRequest(`/services?organizationId=${encodeURIComponent(organizationId)}`);
export const getService = (serviceId) => apiRequest(`/services/${encodeURIComponent(serviceId)}`);
export const getAvailability = (serviceId, date) =>
  apiRequest(`/services/${encodeURIComponent(serviceId)}/availability?date=${encodeURIComponent(date)}`);
export const createAppointment = (appointment) => apiRequest('/appointments', { method: 'POST', body: appointment });
export const joinWalkInQueue = (organizationId, serviceId) =>
  apiRequest('/queue/join', { method: 'POST', body: { organizationId, serviceId } });
export const getMyAppointments = () => apiRequest('/appointments/my');
export const cancelAppointment = (id) => apiRequest(`/appointments/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const rescheduleAppointment = (id, date, time) =>
  apiRequest(`/appointments/${encodeURIComponent(id)}`, { method: 'PUT', body: { appointmentDate: date, appointmentTime: time } });
export const getQueue = (serviceId, date) =>
  apiRequest(`/queue/${encodeURIComponent(serviceId)}?date=${encodeURIComponent(date)}`);
export const callNext = (serviceId, date) => apiRequest('/queue/next', { method: 'POST', body: { serviceId, date } });
export const setQueueStatus = (serviceId, action) =>
  apiRequest(`/queue/${encodeURIComponent(serviceId)}/${action}`, { method: 'POST' });
export const updateQueueEntry = (queueId, action, serviceId, date) =>
  apiRequest(`/queue/${encodeURIComponent(queueId)}/${encodeURIComponent(action)}`, {
    method: 'POST',
    body: { serviceId, date }
  });
export const getNotifications = () => apiRequest('/notifications');
export const subscribeToEmailNotifications = () => apiRequest('/notifications/subscribe', { method: 'POST' });
export const getStaffAppointments = (date) => apiRequest(`/staff/appointments?date=${encodeURIComponent(date)}`);
export const createOrganization = (organization) =>
  apiRequest('/admin/organizations', { method: 'POST', body: organization });
export const createDepartment = (department) =>
  apiRequest('/admin/departments', { method: 'POST', body: department });
export const createService = (service) =>
  apiRequest('/admin/services', { method: 'POST', body: service });
export const getAppointmentDocuments = (appointmentId) =>
  apiRequest(`/appointments/${encodeURIComponent(appointmentId)}/documents`);

export async function uploadDocument(appointmentId, file, documentType) {
  const { document } = await apiRequest('/documents/upload', {
    method: 'POST',
    body: {
      appointmentId,
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size,
      documentType
    }
  });

  const form = new FormData();
  Object.entries(document.fields).forEach(([key, value]) => form.append(key, value));
  form.append('file', file);
  const response = await fetch(document.uploadUrl, { method: document.method, body: form });
  if (!response.ok) throw new Error('The secure document upload did not complete. Please try again.');
  await apiRequest(`/documents/${encodeURIComponent(document.documentId)}/complete`, { method: 'POST' });
  return document;
}

export const getDocumentDownloadUrl = async (documentId) =>
  (await apiRequest(`/documents/${encodeURIComponent(documentId)}/download`)).url;

export const deleteDocument = (documentId) =>
  apiRequest(`/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
