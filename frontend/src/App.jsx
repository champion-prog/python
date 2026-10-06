import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
  cancelAppointment,
  callNext,
  createAppointment,
  createDepartment,
  createOrganization,
  createService,
  deleteDocument,
  getAppointmentDocuments,
  getAvailability,
  getDocumentDownloadUrl,
  getDepartments,
  getMyProfile,
  getMyAppointments,
  getNotifications,
  getOrganizations,
  getQueue,
  getServices,
  getStaffAppointments,
  hasApiConfiguration,
  rescheduleAppointment,
  joinWalkInQueue,
  subscribeToEmailNotifications,
  setQueueStatus,
  updateQueueEntry,
  uploadDocument
} from './services/api';
import {
  confirmSignUp,
  getTokenClaims,
  requestPasswordReset,
  resetPassword,
  signIn,
  signOut,
  signUp
} from './services/auth';

const getToday = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

const formatDate = (value) => value
  ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

const friendlyStatus = (value = '') => value.toLowerCase().replaceAll('_', ' ');

const authErrorMessage = (error) => {
  const messages = {
    NotAuthorizedException: 'Your email or password is incorrect.',
    UserNotConfirmedException: 'Verify your email address before signing in.',
    UsernameExistsException: 'An account with that email already exists.',
    CodeMismatchException: 'That verification code is not correct.',
    ExpiredCodeException: 'That verification code has expired. Request a new one.'
  };
  return messages[error.name] ?? error.message ?? 'Authentication could not be completed.';
};

const wizardSteps = ['Organization', 'Department', 'Service', 'Date', 'Time slot', 'Documents', 'Confirm'];

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = location.pathname.slice(1) || 'home';
  const setView = (destination) => navigate(destination === 'home' ? '/' : `/${destination}`);
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [organizations, setOrganizations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [services, setServices] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [notificationNotice, setNotificationNotice] = useState('');
  const [walkInConfirmation, setWalkInConfirmation] = useState(null);
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [queue, setQueue] = useState(null);
  const [bookingStep, setBookingStep] = useState(0);
  const [booking, setBooking] = useState({
    organizationId: '',
    departmentId: '',
    serviceId: '',
    date: getToday(),
    time: '',
    documentType: 'Supporting document',
    file: null
  });
  const [availability, setAvailability] = useState([]);
  const [confirmation, setConfirmation] = useState(null);
  const [documentRows, setDocumentRows] = useState([]);
  const [staffDate, setStaffDate] = useState(getToday());
  const [staffAppointments, setStaffAppointments] = useState([]);
  const [reschedulingId, setReschedulingId] = useState('');
  const [rescheduleDate, setRescheduleDate] = useState(getToday());
  const [rescheduleTime, setRescheduleTime] = useState('');

  const roles = user?.roles ?? [];
  const isStaff = roles.includes('STAFF') || roles.includes('ADMIN');
  const isAdmin = roles.includes('ADMIN');
  const selectedAppointment = useMemo(() => appointments.find((item) => !['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(item.status)), [appointments]);

  const reportError = useCallback((message) => setError(message), []);

  const loadCatalog = useCallback(async () => {
    const response = await getOrganizations();
    setOrganizations(response.organizations ?? []);
    if (response.organizations?.length) {
      const servicesResponse = await getServices(response.organizations[0].organizationId);
      setServices(servicesResponse.services ?? []);
      const departmentResponse = await getDepartments(response.organizations[0].organizationId);
      setDepartments(departmentResponse.departments ?? []);
    }
  }, []);

  const loadProfile = useCallback(async () => {
    const response = await getMyProfile();
    setUser((current) => current ? { ...current, name: response.user.name ?? current.name } : current);
  }, []);

  const loadAppointments = useCallback(async () => {
    const response = await getMyAppointments();
    setAppointments(response.appointments ?? []);
  }, []);

  const run = useCallback(async (task, onSuccess) => {
    setBusy(true);
    setError('');
    try {
      const result = await task();
      if (onSuccess) await onSuccess(result);
      return result;
    } catch (requestError) {
      reportError(requestError.message || 'The request could not be completed.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [reportError]);

  useEffect(() => {
    if (!session) return;
    void run(async () => {
      await Promise.all([loadCatalog(), loadAppointments(), loadProfile()]);
      setView(isStaff ? 'staff' : 'dashboard');
    });
  }, [session, isStaff, loadAppointments, loadCatalog, loadProfile, run]);

  useEffect(() => {
    if (!selectedServiceId && selectedAppointment?.serviceId) setSelectedServiceId(selectedAppointment.serviceId);
  }, [selectedServiceId, selectedAppointment]);

  const updateBooking = (field, value) => {
    setBooking((current) => ({ ...current, [field]: value }));
    if (field === 'organizationId') {
      setBooking((current) => ({ ...current, organizationId: value, departmentId: '', serviceId: '', time: '' }));
      void run(async () => {
        const [departmentResponse, serviceResponse] = await Promise.all([getDepartments(value), getServices(value)]);
        setDepartments(departmentResponse.departments ?? []);
        setServices(serviceResponse.services ?? []);
      });
    }
    if (field === 'departmentId') {
      setBooking((current) => ({ ...current, departmentId: value, serviceId: '', time: '' }));
    }
    if (field === 'serviceId') {
      setSelectedServiceId(value);
      setBooking((current) => ({ ...current, serviceId: value, time: '' }));
      void run(async () => {
        const response = await getAvailability(value, booking.date);
        setAvailability(response.slots ?? []);
      });
    }
    if (field === 'date') {
      setBooking((current) => ({ ...current, date: value, time: '' }));
      if (booking.serviceId && value) {
        void run(async () => {
          const response = await getAvailability(booking.serviceId, value);
          setAvailability(response.slots ?? []);
        });
      }
    }
  };

  const startBooking = () => {
    if (!session) {
      setAuthMode('login');
      setView('auth');
      return;
    }
    setError('');
    setConfirmation(null);
    setBookingStep(0);
    setBooking({
      organizationId: '',
      departmentId: '',
      serviceId: '',
      date: getToday(),
      time: '',
      documentType: 'Supporting document',
      file: null
    });
    setAvailability([]);
    setView('booking');
  };

  const startWalkIn = () => {
    setWalkInConfirmation(null);
    setBooking((current) => ({
      ...current,
      organizationId: organizations[0]?.organizationId ?? '',
      departmentId: '',
      serviceId: ''
    }));
    setView(session ? 'join' : 'auth');
  };

  const submitWalkIn = async () => {
    const result = await run(() => joinWalkInQueue(booking.organizationId, booking.serviceId), async (response) => {
      setWalkInConfirmation(response);
      setAppointments((current) => [response.appointment, ...current]);
      setSelectedServiceId(response.appointment.serviceId);
      await loadAppointments();
    });
    if (result) setView('join');
  };

  const signInUser = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setAuthNotice('');
    try {
      const result = await signIn(String(form.get('email')), String(form.get('password')));
      const claims = getTokenClaims(result.idToken);
      setSession(result);
      setUser({
        id: claims.sub,
        name: claims.name ?? String(form.get('email')).split('@')[0],
        email: claims.email ?? String(form.get('email')),
        roles: Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'] : (claims['cognito:groups'] ?? '').split(',')
      });
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setBusy(false);
    }
  };

  const submitRegistration = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirmPassword'))) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const email = String(form.get('email'));
      await signUp({
        name: String(form.get('name')),
        email,
        phone: String(form.get('phone')),
        password
      });
      setAuthEmail(email);
      setAuthMode('verify');
      setAuthNotice('We sent a verification code to your email address.');
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setBusy(false);
    }
  };

  const submitVerification = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await confirmSignUp(authEmail, String(form.get('code')));
      setAuthMode('login');
      setAuthNotice('Email verified. Sign in to continue.');
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setBusy(false);
    }
  };

  const submitPasswordReset = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (authMode === 'forgot') {
        await requestPasswordReset(String(form.get('email')));
        setAuthEmail(String(form.get('email')));
        setAuthMode('reset');
        setAuthNotice('Enter the code sent to your email and choose a new password.');
      } else {
        await resetPassword(authEmail, String(form.get('code')), String(form.get('password')));
        setAuthMode('login');
        setAuthNotice('Password updated. You can now sign in.');
      }
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    signOut();
    setSession(null);
    setUser(null);
    setAppointments([]);
    setNotifications([]);
    setView('home');
  };

  const advanceBooking = async () => {
    setError('');
    const valid = [
      Boolean(booking.organizationId),
      Boolean(booking.departmentId),
      Boolean(booking.serviceId),
      Boolean(booking.date && booking.date >= getToday()),
      Boolean(booking.time),
      true
    ];
    if (!valid[bookingStep]) {
      setError(bookingStep === 3 ? 'Select today or a future date.' : 'Please make a selection to continue.');
      return;
    }
    if (bookingStep === 3) {
      const result = await run(() => getAvailability(booking.serviceId, booking.date), (response) => setAvailability(response.slots ?? []));
      if (!result) return;
      if (result.slots?.length === 0) {
        setError('No available slots on that date. Choose another date.');
        return;
      }
    }
    setBookingStep((step) => Math.min(step + 1, wizardSteps.length - 1));
  };

  const submitBooking = async () => {
    const result = await run(async () => {
      const response = await createAppointment({
        organizationId: booking.organizationId,
        serviceId: booking.serviceId,
        appointmentDate: booking.date,
        appointmentTime: booking.time
      });
      if (booking.file) {
        try {
          await uploadDocument(response.appointment.appointmentId, booking.file, booking.documentType);
        } catch (uploadError) {
          response.documentError = uploadError.message;
        }
      }
      return response;
    }, async (response) => {
      setConfirmation(response);
      await loadAppointments();
    });
    if (result) setView('booking');
  };

  const loadQueue = useCallback(async (serviceId, date) => {
    if (!serviceId || !date) return null;
    const response = await getQueue(serviceId, date);
    setQueue(response);
    return response;
  }, []);

  useEffect(() => {
    if (view !== 'dashboard' || !selectedAppointment?.serviceId) return;
    void loadQueue(selectedAppointment.serviceId, selectedAppointment.appointmentDate)
      .catch((requestError) => setError(requestError.message));
  }, [view, selectedAppointment, loadQueue]);

  useEffect(() => {
    if (view !== 'queue' || !selectedServiceId) return undefined;
    let active = true;
    const date = selectedAppointment?.appointmentDate ?? getToday();
    const refresh = () => {
      void getQueue(selectedServiceId, date)
        .then((value) => { if (active) setQueue(value); })
        .catch((requestError) => { if (active) setError(requestError.message); });
    };
    refresh();
    const interval = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [view, selectedServiceId, selectedAppointment]);

  const openNotifications = async () => {
    const response = await run(getNotifications);
    if (response) {
      setNotifications(response.notifications ?? []);
      setView('notifications');
    }
  };

  const enableEmailNotifications = async () => {
    const result = await run(subscribeToEmailNotifications);
    if (result) setNotificationNotice(result.message);
  };

  const openStaffDashboard = async () => {
    const result = await run(() => getStaffAppointments(staffDate), (response) => setStaffAppointments(response.appointments ?? []));
    if (result) setView('staff');
  };

  const uploadForAppointment = async (appointmentId, event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await run(async () => {
      await uploadDocument(appointmentId, file, 'Supporting document');
      return getAppointmentDocuments(appointmentId);
    }, (response) => setDocumentRows(response.documents ?? []));
    event.target.value = '';
  };

  const viewAppointmentDocuments = async (appointmentId) => {
    const result = await run(() => getAppointmentDocuments(appointmentId), (response) => setDocumentRows(response.documents ?? []));
    if (result) setView('documents');
  };

  const goTo = (destination) => {
    setError('');
    if (!session && ['dashboard', 'booking', 'join', 'appointments', 'queue', 'documents', 'notifications', 'staff', 'admin'].includes(destination)) {
      setAuthMode('login');
      setView('auth');
      return;
    }
    setView(destination);
    if (destination === 'dashboard' && session) void run(async () => { await loadAppointments(); await loadCatalog(); });
    if (destination === 'appointments' && session) void run(loadAppointments);
    if (destination === 'notifications' && session) {
      void run(getNotifications, (response) => setNotifications(response.notifications ?? []));
    }
    if (destination === 'staff' && session) void openStaffDashboard();
    if (destination === 'admin' && session) void run(loadCatalog);
    if (destination === 'join' && session) void run(loadCatalog);
    if (destination === 'queue') {
      const serviceId = selectedAppointment?.serviceId ?? selectedServiceId;
      if (serviceId) setSelectedServiceId(serviceId);
      else setError('Book an appointment to select a queue to track.');
    }
  };

  const renderHome = () => (
    <main className="page-shell">
      <section className="hero-section">
        <div className="hero-copy">
          <span className="eyebrow">A better way to be served</span>
          <h1>Skip the Waiting. Manage Your Time.</h1>
          <p>Book appointments, join queues remotely, track your position, and receive notifications when your turn is approaching.</p>
          <div className="cta-row">
            <button className="primary-button" onClick={startBooking}>Book Appointment</button>
            <button className="secondary-button" onClick={startWalkIn}>Join Queue</button>
            {!session && <button className="text-button" onClick={() => goTo('auth')}>Login</button>}
          </div>
          <div className="mini-stat-row">
            <div><strong>One place</strong><span>For services and bookings</span></div>
            <div><strong>Live status</strong><span>Know before you go</span></div>
            <div><strong>Secure</strong><span>AWS identity and storage</span></div>
          </div>
        </div>
        <div className="hero-card">
          <div className="hero-card-top"><span>SmartQueue workflow</span><span className="status-pill good">Ready when you are</span></div>
          <div className="service-preview">
            <span className="service-icon">SQ</span>
            <div><small>Appointments, queues, documents</small><strong>From booking to being served</strong></div>
          </div>
          <div className="workflow-steps">
            {['Select a service', 'Book a time or join a queue', 'Track your turn', 'Get served'].map((step, index) => (
              <div key={step}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong></div>
            ))}
          </div>
        </div>
      </section>
      <section className="feature-section">
        <div className="section-heading"><span className="eyebrow">Everything in one place</span><h2>Simple service access for every organization</h2></div>
        <div className="feature-grid">
          {[
            ['Online appointment booking', 'Choose a service and a real available time slot.'],
            ['Digital queue tokens', 'A unique token connects your appointment to the service queue.'],
            ['Live queue tracking', 'Watch people ahead and your estimated wait change.'],
            ['Smart notifications', 'Get updates when appointments are booked and turns are called.'],
            ['Secure documents', 'Upload PDFs and images into private, time-limited S3 storage.'],
            ['Staff operations', 'Call the next person and update queue status from one place.']
          ].map(([title, description]) => <article className="feature-card" key={title}><div className="feature-icon">✓</div><div><strong>{title}</strong><p>{description}</p></div></article>)}
        </div>
      </section>
    </main>
  );

  const renderAuth = () => (
    <main className="page-shell auth-shell">
      <div className="auth-card">
        <span className="eyebrow">Secure account</span>
        <h2>{({ login: 'Welcome back', register: 'Create your account', verify: 'Verify your email', forgot: 'Reset your password', reset: 'Choose a new password' })[authMode]}</h2>
        <p className="muted-copy">Sign-in and account recovery are handled by Amazon Cognito.</p>
        {authNotice && <p className="success-message" role="status">{authNotice}</p>}
        {authMode === 'login' && <form className="auth-form" onSubmit={signInUser}>
          <label>Email<input name="email" type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button className="primary-button full-width" disabled={busy}>{busy ? 'Signing in…' : 'Login'}</button>
          <div className="auth-links"><button type="button" onClick={() => setAuthMode('forgot')}>Forgot password?</button><button type="button" onClick={() => setAuthMode('register')}>Create account</button></div>
        </form>}
        {authMode === 'register' && <form className="auth-form" onSubmit={submitRegistration}>
          <label>Full name<input name="name" autoComplete="name" required /></label>
          <label>Email<input name="email" type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
          <label>Phone number <span className="field-hint">Include country code, for example +1 4155550130</span><input name="phone" type="tel" autoComplete="tel" /></label>
          <label>Password<input name="password" type="password" autoComplete="new-password" minLength="12" required /></label>
          <label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength="12" required /></label>
          <button className="primary-button full-width" disabled={busy}>{busy ? 'Creating account…' : 'Register'}</button>
          <button type="button" className="text-button" onClick={() => setAuthMode('login')}>Back to login</button>
        </form>}
        {authMode === 'verify' && <form className="auth-form" onSubmit={submitVerification}>
          <label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" required /></label>
          <button className="primary-button full-width" disabled={busy}>Verify email</button>
          <button type="button" className="text-button" onClick={() => setAuthMode('login')}>Back to login</button>
        </form>}
        {authMode === 'forgot' && <form className="auth-form" onSubmit={submitPasswordReset}>
          <label>Email<input name="email" type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
          <button className="primary-button full-width" disabled={busy}>Send reset code</button>
          <button type="button" className="text-button" onClick={() => setAuthMode('login')}>Back to login</button>
        </form>}
        {authMode === 'reset' && <form className="auth-form" onSubmit={submitPasswordReset}>
          <label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" required /></label>
          <label>New password<input name="password" type="password" autoComplete="new-password" minLength="12" required /></label>
          <button className="primary-button full-width" disabled={busy}>Update password</button>
        </form>}
        {!hasApiConfiguration() && <p className="warning-message">Deployment configuration is missing. Configure the AWS values in <code>.env</code> after deploying the SAM stack.</p>}
      </div>
    </main>
  );

  const renderDashboard = () => (
    <main className="page-shell">
      <PageHeading eyebrow="Your account" title={`Welcome, ${user?.name ?? 'User'}`} description="Your appointments and queue updates are loaded securely from AWS." />
      <div className="dashboard-grid">
        <section className="panel primary-panel">
          <div className="panel-header"><h3>Upcoming appointment</h3>{selectedAppointment && <StatusBadge status={selectedAppointment.status} />}</div>
          {!selectedAppointment ? <EmptyState title="No appointments yet" detail="Choose a service to book your first appointment." action="Book appointment" onAction={startBooking} /> : <>
            <div className="appointment-meta">
              <InfoCell label="Service" value={selectedAppointment.serviceName} />
              <InfoCell label="Date" value={formatDate(selectedAppointment.appointmentDate)} />
              <InfoCell label="Time" value={selectedAppointment.appointmentTime} />
              <InfoCell label="Queue token" value={selectedAppointment.tokenNumber} />
            </div>
            <div className="dashboard-actions">
              <button className="primary-button" onClick={() => { setSelectedServiceId(selectedAppointment.serviceId); goTo('queue'); }}>Track queue</button>
              <button className="secondary-button" onClick={() => viewAppointmentDocuments(selectedAppointment.appointmentId)}>View documents</button>
              <label className="secondary-button upload-button">Upload document<input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(event) => uploadForAppointment(selectedAppointment.appointmentId, event)} /></label>
              <button className="text-button danger-text" onClick={() => void run(() => cancelAppointment(selectedAppointment.appointmentId), loadAppointments)}>Cancel appointment</button>
            </div>
          </>}
        </section>
        <section className="panel queue-panel">
          <div className="panel-header"><h3>Current queue</h3><span className="status-pill info">{queue?.status ?? 'Live updates'}</span></div>
          {!selectedAppointment ? <p className="muted-copy">Book a service appointment to receive a queue token.</p> : <>
            <div className="queue-hero"><small>Your token</small><h2>{selectedAppointment.tokenNumber}</h2></div>
            <div className="queue-stats"><InfoCell label="Now serving" value={queue?.currentlyServing ?? '—'} /><InfoCell label="People ahead" value={queue?.peopleAhead ?? '—'} /><InfoCell label="Estimated wait" value={queue ? `${queue.estimatedWaitMinutes} min` : '—'} /></div>
            <button className="secondary-button" onClick={() => { setSelectedServiceId(selectedAppointment.serviceId); goTo('queue'); }}>Open live queue</button>
          </>}
        </section>
        <section className="panel wide-panel"><div className="panel-header"><h3>Recent notifications</h3><button className="text-button" onClick={openNotifications}>View all</button></div>
          <p className="muted-copy">Check appointment confirmations, reminders, and queue updates.</p>
        </section>
      </div>
    </main>
  );

  const renderBooking = () => {
    const filteredServices = services.filter((service) => !booking.departmentId || service.departmentId === booking.departmentId);
    const selectedOrganization = organizations.find((item) => item.organizationId === booking.organizationId);
    const selectedDepartment = departments.find((item) => item.departmentId === booking.departmentId);
    const selectedService = services.find((item) => item.serviceId === booking.serviceId);
    const steps = [
      <div className="wizard-grid">{organizations.map((item) => <button key={item.organizationId} className={booking.organizationId === item.organizationId ? 'option-card selected' : 'option-card'} onClick={() => updateBooking('organizationId', item.organizationId)}><strong>{item.name}</strong><small>{item.type}</small></button>)}</div>,
      <div className="wizard-grid">{departments.map((item) => <button key={item.departmentId} className={booking.departmentId === item.departmentId ? 'option-card selected' : 'option-card'} onClick={() => updateBooking('departmentId', item.departmentId)}><strong>{item.name}</strong><small>{item.description}</small></button>)}{departments.length === 0 && <p className="empty-copy">No departments have been added to this organization.</p>}</div>,
      <div className="wizard-grid">{filteredServices.map((item) => <button key={item.serviceId} className={booking.serviceId === item.serviceId ? 'option-card selected' : 'option-card'} onClick={() => updateBooking('serviceId', item.serviceId)}><strong>{item.name}</strong><small>{item.description || `${item.averageServiceTime} minute average service time`}</small></button>)}{filteredServices.length === 0 && <p className="empty-copy">No services are available for this department.</p>}</div>,
      <div className="calendar-box"><label>Select appointment date<input type="date" min={getToday()} value={booking.date} onChange={(event) => updateBooking('date', event.target.value)} /></label><button className="secondary-button" onClick={() => void run(async () => { const result = await getAvailability(booking.serviceId, booking.date); setAvailability(result.slots ?? []); return result; })}>Check availability</button></div>,
      <div className="wizard-grid">{availability.map((slot) => <button key={slot} className={booking.time === slot ? 'option-card selected' : 'option-card'} onClick={() => updateBooking('time', slot)}>{slot}</button>)}{availability.length === 0 && <p className="empty-copy">No available times loaded. Choose a date and check availability.</p>}</div>,
      <div className="calendar-box document-picker"><label>Optional appointment document <span className="field-hint">PDF, JPG, JPEG, or PNG, up to 10 MB</span><input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(event) => setBooking((current) => ({ ...current, file: event.target.files?.[0] ?? null }))} /></label>{booking.file && <p>Selected: {booking.file.name}</p>}</div>,
      <div className="confirmation-card"><h3>Review your appointment</h3><ul><li><span>Organization</span><strong>{selectedOrganization?.name}</strong></li><li><span>Department</span><strong>{selectedDepartment?.name}</strong></li><li><span>Service</span><strong>{selectedService?.name}</strong></li><li><span>Date</span><strong>{formatDate(booking.date)}</strong></li><li><span>Time</span><strong>{booking.time}</strong></li><li><span>Document</span><strong>{booking.file?.name ?? 'None'}</strong></li></ul><div className="booking-notice">A unique appointment ID and queue token are assigned by the AWS backend when you confirm.</div></div>
    ];
    if (confirmation) return <main className="page-shell booking-shell"><BookingSuccess confirmation={confirmation} onAppointments={() => goTo('appointments')} onQueue={() => { setSelectedServiceId(confirmation.appointment.serviceId); goTo('queue'); }} /></main>;
    return <main className="page-shell booking-shell"><div className="wizard-card">
      <div className="panel-header"><div><span className="eyebrow">New booking</span><h2>Book an appointment</h2></div><span className="status-pill info">Step {bookingStep + 1} of {wizardSteps.length}</span></div>
      <div className="step-progress">{wizardSteps.map((step, index) => <button key={step} disabled={index > bookingStep} className={index === bookingStep ? 'step-pill active' : 'step-pill'} onClick={() => setBookingStep(index)}>{step}</button>)}</div>
      {organizations.length === 0 && <EmptyState title="No organizations are available" detail="An administrator must configure an organization and its services before appointments can be booked." />}
      <div className="wizard-body">{steps[bookingStep]}</div>
      <div className="wizard-actions"><button className="secondary-button" disabled={bookingStep === 0 || busy} onClick={() => setBookingStep((step) => Math.max(0, step - 1))}>Back</button>{bookingStep < wizardSteps.length - 1 ? <button className="primary-button" disabled={busy || organizations.length === 0} onClick={() => void advanceBooking()}>Continue</button> : <button className="primary-button" disabled={busy} onClick={() => void submitBooking()}>{busy ? 'Booking…' : 'Confirm appointment'}</button>}</div>
    </div></main>;
  };

  const renderAppointments = () => <main className="page-shell">
    <PageHeading eyebrow="Bookings" title="My appointments" description="View and manage appointments from your account." action={<button className="primary-button" onClick={startBooking}>Book appointment</button>} />
    <section className="panel appointments-panel">
      {appointments.length === 0 ? <EmptyState title="No appointments" detail="Appointments created through this account will appear here." action="Book an appointment" onAction={startBooking} /> : <div className="appointments-list">{appointments.map((appointment) => <article className="appointment-row" key={appointment.appointmentId}><div><strong>{appointment.serviceName}</strong><small>{appointment.organizationId}</small><small>{appointment.appointmentId}</small></div><span>{formatDate(appointment.appointmentDate)} · {appointment.appointmentTime}</span><StatusBadge status={appointment.status} /><div className="row-actions"><button className="text-button" onClick={() => viewAppointmentDocuments(appointment.appointmentId)}>Documents</button>{['BOOKED', 'CONFIRMED'].includes(appointment.status) && <><button className="text-button" onClick={() => { setReschedulingId(appointment.appointmentId); setRescheduleDate(appointment.appointmentDate); setRescheduleTime(appointment.appointmentTime); }}>Reschedule</button><button className="text-button danger-text" onClick={() => { if (window.confirm('Cancel this appointment?')) void run(() => cancelAppointment(appointment.appointmentId), loadAppointments); }}>Cancel</button></>}</div>{reschedulingId === appointment.appointmentId && <form className="reschedule-form" onSubmit={(event) => { event.preventDefault(); void run(() => rescheduleAppointment(appointment.appointmentId, rescheduleDate, rescheduleTime), async () => { setReschedulingId(''); await loadAppointments(); }); }}><label>New date<input type="date" min={getToday()} required value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} /></label><label>New time<input type="time" required value={rescheduleTime} onChange={(event) => setRescheduleTime(event.target.value)} /></label><button className="primary-button" disabled={busy}>Save reschedule</button><button className="secondary-button" type="button" onClick={() => setReschedulingId('')}>Close</button></form>}</article>)}</div>}
    </section>
  </main>;

  const renderWalkIn = () => walkInConfirmation
    ? <main className="page-shell booking-shell"><BookingSuccess confirmation={walkInConfirmation} onAppointments={() => goTo('appointments')} onQueue={() => { setSelectedServiceId(walkInConfirmation.appointment.serviceId); goTo('queue'); }} /></main>
    : <main className="page-shell booking-shell"><section className="wizard-card"><span className="eyebrow">Walk-in queue</span><h2>Join a service queue</h2><p className="muted-copy">Get a token for today's queue without reserving an appointment slot.</p><div className="auth-form"><label>Organization<select value={booking.organizationId} onChange={(event) => updateBooking('organizationId', event.target.value)} required><option value="">Select an organization</option>{organizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.name}</option>)}</select></label><label>Service<select value={booking.serviceId} onChange={(event) => updateBooking('serviceId', event.target.value)} required><option value="">Select a service</option>{services.filter((service) => service.organizationId === booking.organizationId).map((service) => <option key={service.serviceId} value={service.serviceId}>{service.name}</option>)}</select></label><button className="primary-button" disabled={!booking.organizationId || !booking.serviceId || busy} onClick={submitWalkIn}>{busy ? 'Joining…' : 'Join queue and get token'}</button></div></section></main>;

  const renderQueue = () => <main className="page-shell">
    <PageHeading eyebrow="Live tracking" title="Queue status" description="Queue status refreshes automatically every 10 seconds." />
    {!selectedServiceId ? <EmptyState title="Choose a queue" detail="Book an appointment to select its service queue." action="Book appointment" onAction={startBooking} /> : <section className="dashboard-grid">
      <div className="panel queue-panel"><div className="panel-header"><h3>Current queue</h3><span className="status-pill good">{queue?.status ?? 'Loading'}</span></div><div className="queue-hero"><small>Currently serving</small><h2>{queue?.currentlyServing ?? '—'}</h2></div><div className="queue-stats"><InfoCell label="Your token" value={selectedAppointment?.tokenNumber ?? '—'} /><InfoCell label="People ahead" value={queue?.peopleAhead ?? '—'} /><InfoCell label="Estimated wait" value={queue ? `${queue.estimatedWaitMinutes} min` : '—'} /></div><div className="progress-bar"><span style={{ width: `${queue?.entries?.length ? Math.max(5, Math.min(100, 100 - (queue.peopleAhead / queue.entries.length) * 100)) : 0}%` }} /></div><button className="secondary-button" onClick={() => void run(() => loadQueue(selectedServiceId, selectedAppointment?.appointmentDate ?? getToday()))}>Refresh queue</button></div>
      <div className="panel wide-panel"><div className="panel-header"><h3>Queue entries</h3></div>{queue?.entries?.length ? <div className="queue-list">{queue.entries.map((entry) => <div className="queue-item" key={entry.queueId}><span>{entry.tokenNumber}</span><strong>{entry.tokenNumber === selectedAppointment?.tokenNumber ? 'Your appointment' : 'Queue entry'}</strong><StatusBadge status={entry.status} /></div>)}</div> : <p className="empty-copy">There are no queue entries for this date.</p>}</div>
    </section>}
  </main>;

  const renderDocuments = () => <main className="page-shell">
    <PageHeading eyebrow="Secure storage" title="Appointment documents" description="Documents are stored privately in Amazon S3 and are available only through short-lived authorized links." />
    <section className="panel appointments-panel">{documentRows.length === 0 ? <EmptyState title="No documents loaded" detail="Open an appointment and view its documents to load files connected to that booking." /> : <div className="appointments-list">{documentRows.map((document) => <article key={document.documentId} className="appointment-row"><div><strong>{document.fileName}</strong><small>{document.documentType} · {document.status}</small></div><span>{formatDate(document.uploadedAt?.slice(0, 10))}</span><button className="secondary-button" onClick={() => void run(async () => window.open(await getDocumentDownloadUrl(document.documentId), '_blank', 'noopener,noreferrer'))}>View / Download</button><button className="text-button danger-text" onClick={() => void run(() => deleteDocument(document.documentId), async () => setDocumentRows((rows) => rows.filter((item) => item.documentId !== document.documentId)))}>Delete</button></article>)}</div>}</section>
  </main>;

  const renderNotifications = () => <main className="page-shell"><PageHeading eyebrow="Updates" title="Notifications" description="Appointment and queue events sent to your account." action={<button className="secondary-button" onClick={enableEmailNotifications}>Enable email notifications</button>} />{notificationNotice && <p className="success-message">{notificationNotice}</p>}<section className="panel appointments-panel">{notifications.length === 0 ? <EmptyState title="No notifications yet" detail="New appointment and queue updates will appear here." /> : <div className="appointments-list">{notifications.map((item) => <article className="appointment-row" key={item.notificationId}><div><strong>{friendlyStatus(item.type)}</strong><small>{item.message}</small></div><span>{new Date(item.createdAt).toLocaleString()}</span><StatusBadge status={item.status} /></article>)}</div>}</section></main>;

  const renderStaff = () => <main className="page-shell">
    <PageHeading eyebrow="Staff operations" title="Service queue" description="View your assigned appointments and manage the service queue." action={<div className="inline-control"><label htmlFor="staff-date">Service date</label><input id="staff-date" type="date" value={staffDate} onChange={(event) => setStaffDate(event.target.value)} /><button className="secondary-button" onClick={openStaffDashboard}>Load queue</button></div>} />
    {!isStaff ? <EmptyState title="Staff access required" detail="Ask an administrator to add your Cognito account to the STAFF group." /> : <div className="staff-grid"><section className="panel staff-panel"><div className="panel-header"><h3>Assigned appointments</h3><span className="status-pill info">{staffAppointments.length} records</span></div><div className="queue-list">{staffAppointments.map((appointment) => <div className="queue-item doctor-row" key={appointment.appointmentId}><span>{appointment.tokenNumber}</span><strong>{appointment.serviceName}</strong><span>{appointment.appointmentTime}</span><StatusBadge status={appointment.status} /><div className="row-actions">{appointment.status === 'CALLED' && <button className="text-button" onClick={() => void run(() => updateQueueEntry(appointment.queueId, 'start', appointment.serviceId, staffDate), openStaffDashboard)}>Start</button>}{appointment.status === 'IN_SERVICE' && <button className="text-button" onClick={() => void run(() => updateQueueEntry(appointment.queueId, 'complete', appointment.serviceId, staffDate), openStaffDashboard)}>Complete</button>}{['WAITING', 'CHECKED_IN', 'CALLED'].includes(appointment.status) && <><button className="text-button" onClick={() => void run(() => updateQueueEntry(appointment.queueId, 'skip', appointment.serviceId, staffDate), openStaffDashboard)}>Skip</button><button className="text-button" onClick={() => void run(() => updateQueueEntry(appointment.queueId, 'no-show', appointment.serviceId, staffDate), openStaffDashboard)}>No-show</button></>}</div></div>)}{staffAppointments.length === 0 && <p className="empty-copy">No staff appointments were found for this date.</p>}</div></section>
      <section className="panel staff-actions-panel"><div className="panel-header"><h3>Queue controls</h3></div><label>Service<select value={selectedServiceId} onChange={(event) => setSelectedServiceId(event.target.value)}><option value="">Select service</option>{services.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.name}</option>)}</select></label><div className="action-stack"><button className="primary-button" disabled={!selectedServiceId || busy} onClick={() => void run(() => callNext(selectedServiceId, staffDate), openStaffDashboard)}>Call next person</button><button className="secondary-button" disabled={!selectedServiceId || busy} onClick={() => void run(() => setQueueStatus(selectedServiceId, 'pause'), () => loadQueue(selectedServiceId, staffDate))}>Pause queue</button><button className="secondary-button" disabled={!selectedServiceId || busy} onClick={() => void run(() => setQueueStatus(selectedServiceId, 'resume'), () => loadQueue(selectedServiceId, staffDate))}>Resume queue</button></div></section></div>}
  </main>;

  const renderAdmin = () => <main className="page-shell"><PageHeading eyebrow="Administration" title="Manage SmartQueue" description="Create organizations, departments, and the services people can book." />
    {!isAdmin ? <EmptyState title="Administrator access required" detail="Ask your deployment owner to place this user in the Cognito ADMIN group." /> : <div className="staff-grid">    <form className="panel auth-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void run(() => createOrganization({ name: String(data.get('name')), type: String(data.get('type')) }), async () => { form.reset(); await loadCatalog(); }); }}><h3>Create organization</h3><label>Organization name<input name="name" required /></label><label>Organization type<select name="type">{['College', 'Salon', 'Bank', 'Government Service Center', 'Clinic', 'Other'].map((type) => <option key={type}>{type}</option>)}</select></label><button className="primary-button" disabled={busy}>Create organization</button></form>
      <form className="panel auth-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void run(() => createDepartment({ organizationId: String(data.get('organizationId')), name: String(data.get('name')), description: String(data.get('description')) }), async () => { form.reset(); await loadCatalog(); }); }}><h3>Create department</h3><label>Organization<select name="organizationId" required>{organizations.map((org) => <option key={org.organizationId} value={org.organizationId}>{org.name}</option>)}</select></label><label>Department name<input name="name" required /></label><label>Description<input name="description" /></label><button className="primary-button" disabled={busy}>Create department</button></form>
      <form className="panel auth-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void run(() => createService({ organizationId: String(data.get('organizationId')), departmentId: String(data.get('departmentId')), name: String(data.get('name')), description: String(data.get('description')), averageServiceTime: Number(data.get('averageServiceTime')), staffId: String(data.get('staffId')) || undefined }), async () => { form.reset(); await loadCatalog(); }); }}><h3>Create bookable service</h3><label>Organization<select name="organizationId" required>{organizations.map((org) => <option key={org.organizationId} value={org.organizationId}>{org.name}</option>)}</select></label><label>Department<select name="departmentId" required>{departments.map((department) => <option key={department.departmentId} value={department.departmentId}>{department.name}</option>)}</select></label><label>Service name<input name="name" required /></label><label>Assigned staff Cognito subject <span className="field-hint">Optional</span><input name="staffId" /></label><label>Average service time (minutes)<input name="averageServiceTime" type="number" min="1" defaultValue="5" required /></label><button className="primary-button" disabled={busy}>Create service</button></form>
      <section className="panel admin-panel"><div className="panel-header"><h3>Organizations and services</h3></div>{organizations.map((org) => <div className="admin-organization" key={org.organizationId}><strong>{org.name}</strong><small>{org.type}</small><div>{services.filter((service) => service.organizationId === org.organizationId).map((service) => <span key={service.serviceId} className="status-tag">{service.name}</span>)}</div></div>)}</section></div>}
  </main>;

  const views = {
    home: renderHome,
    auth: renderAuth,
    dashboard: renderDashboard,
    booking: renderBooking,
    join: renderWalkIn,
    appointments: renderAppointments,
    queue: renderQueue,
    documents: renderDocuments,
    notifications: renderNotifications,
    staff: renderStaff,
    admin: renderAdmin
  };

  const headerLinks = session
    ? [['Dashboard', 'dashboard'], ['Appointments', 'appointments'], ['Queue', 'queue'], ['Documents', 'documents'], ['Notifications', 'notifications'], ...(isStaff ? [['Staff', 'staff']] : []), ...(isAdmin ? [['Admin', 'admin']] : [])]
    : [['Home', 'home'], ['How It Works', 'home']];

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand brand-button" onClick={() => goTo('home')}><span className="brand-mark">S</span><span><strong>SmartQueue</strong><small>Appointments made simple</small></span></button>
      <nav className="nav-bar" aria-label="Main navigation">{headerLinks.map(([label, destination]) => <button className="nav-link" key={label} onClick={() => goTo(destination)}>{label}</button>)}{session && <><button className="nav-link" onClick={startBooking}>Book Appointment</button><button className="nav-link" onClick={startWalkIn}>Join Queue</button></>}</nav>
      <div className="header-actions">{session ? <><span className="user-pill">{user?.name}</span><button className="secondary-button" onClick={logout}>Log out</button></> : <><button className="secondary-button" onClick={() => { setAuthMode('login'); setView('auth'); }}>Login</button><button className="primary-button" onClick={() => { setAuthMode('register'); setView('auth'); }}>Register</button></>}</div>
    </header>
    {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {busy && <div className="busy-line" aria-label="Loading" />}
    {views[view]()}
    <footer className="site-footer"><div><strong>SmartQueue</strong><p>Less waiting. Better service.</p></div><div><span>Secure AWS services</span><span>Support</span><span>Privacy</span></div></footer>
  </div>;
}

function PageHeading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function InfoCell({ label, value }) {
  return <div><span>{label}</span><strong>{value || '—'}</strong></div>;
}

function StatusBadge({ status }) {
  const normalized = String(status ?? 'UNKNOWN').toLowerCase().replaceAll('_', '-');
  return <span className={`status-tag status-${normalized}`}>{friendlyStatus(status)}</span>;
}

function EmptyState({ title, detail, action, onAction }) {
  return <div className="empty-state"><span className="empty-state-mark">SQ</span><strong>{title}</strong><p>{detail}</p>{action && <button className="primary-button" onClick={onAction}>{action}</button>}</div>;
}

function BookingSuccess({ confirmation, onAppointments, onQueue }) {
  const appointment = confirmation.appointment;
  return <div className="wizard-card booking-success"><div className="success-icon" aria-hidden="true">✓</div><span className="eyebrow">Appointment confirmed</span><h2>Your visit is booked</h2><p>Your appointment was created in SmartQueue. Keep your queue token for check-in.</p><div className="confirmation-card"><ul><li><span>Appointment ID</span><strong>{appointment.appointmentId}</strong></li><li><span>Queue token</span><strong className="token-large">{appointment.tokenNumber}</strong></li><li><span>Service</span><strong>{appointment.serviceName}</strong></li><li><span>Date and time</span><strong>{formatDate(appointment.appointmentDate)} · {appointment.appointmentTime}</strong></li><li><span>Estimated wait</span><strong>{confirmation.queue?.estimatedWaitMinutes ?? 0} minutes</strong></li></ul><div className="qr-code"><QRCodeSVG value={JSON.stringify({ id: appointment.appointmentId, token: appointment.tokenNumber })} size={150} title="Appointment check-in QR code" /><small>Show this QR code at check-in</small></div>{confirmation.documentError && <p className="warning-message">Your appointment is booked, but the document could not be uploaded: {confirmation.documentError}</p>}</div><div className="wizard-actions"><button className="secondary-button" onClick={onAppointments}>My appointments</button><button className="primary-button" onClick={onQueue}>Track queue</button></div></div>;
}
