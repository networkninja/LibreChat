import React from 'react';
import { useRecoilState } from 'recoil';
import { Dropdown } from '~/components/ui';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface EngineSTTDropdownProps {
  external: boolean;
  browserDisabled: boolean;
}

const EngineSTTDropdown: React.FC<EngineSTTDropdownProps> = ({ external, browserDisabled }) => {
  const localize = useLocalize();
  const [engineSTT, setEngineSTT] = useRecoilState<string>(store.engineSTT);

  let endpointOptions = [{ value: 'browser', label: localize('com_nav_browser') }];
  if (browserDisabled === true) {
    //used to set value if browswerDisable value is changed after initiation, not sure if necessary
    setEngineSTT('external');
    endpointOptions = [{ value: 'external', label: localize('com_nav_external') }];
  } else if (external && (browserDisabled === false || !browserDisabled)) {
    endpointOptions = [
      { value: 'browser', label: localize('com_nav_browser') },
      { value: 'external', label: localize('com_nav_external') },
    ];
  } else if (browserDisabled === false) {
    //used to set value if browswerDisable value is changed after initiation, not sure if necessary
    setEngineSTT('browser');
  }

  const handleSelect = (value: string) => {
    setEngineSTT(value);
  };

  return (
    <div className="flex items-center justify-between">
      <div>{localize('com_nav_engine')}</div>
      <Dropdown
        value={engineSTT}
        onChange={handleSelect}
        options={endpointOptions}
        sizeClasses="w-[180px]"
        testId="EngineSTTDropdown"
        className="z-50"
      />
    </div>
  );
};

export default EngineSTTDropdown;
