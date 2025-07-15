import React from 'react';
import { useRecoilState } from 'recoil';
import { Dropdown } from '~/components/ui';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface EngineTTSDropdownProps {
  external: boolean;
  browserDisabled: boolean;
}

const EngineTTSDropdown: React.FC<EngineTTSDropdownProps> = ({ external, browserDisabled }) => {
  const localize = useLocalize();
  const [engineTTS, setEngineTTS] = useRecoilState<string>(store.engineTTS);

  let endpointOptions = [{ value: 'browser', label: localize('com_nav_browser') }];
  if (browserDisabled === true) {
    //used to set value if browswerDisable value is changed after initiation, not sure if necessary
    setEngineTTS('external');
    endpointOptions = [{ value: 'external', label: localize('com_nav_external') }];
  } else if (external && (browserDisabled === false || !browserDisabled)) {
    endpointOptions = [
      { value: 'browser', label: localize('com_nav_browser') },
      { value: 'external', label: localize('com_nav_external') },
    ];
  } else if (browserDisabled === false || !browserDisabled) {
    //used to set value if browswerDisable value is changed after initiation, not sure if necessary
    setEngineTTS('browser');
  }

  const handleSelect = (value: string) => {
    setEngineTTS(value);
  };

  return (
    <div className="flex items-center justify-between">
      <div>{localize('com_nav_engine')}</div>
      <Dropdown
        value={engineTTS}
        onChange={handleSelect}
        options={endpointOptions}
        sizeClasses="w-[180px]"
        testId="EngineTTSDropdown"
        className="z-50"
      />
    </div>
  );
};

export default EngineTTSDropdown;
